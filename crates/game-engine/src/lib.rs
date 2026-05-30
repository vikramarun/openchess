//! Authoritative chess game logic.
//!
//! This crate is pure and IO-free: it owns the canonical board state, the
//! server-authoritative clock, move validation (via `shakmaty`), and terminal
//! detection. Wall-clock time is *injected* (`now_ms`) so the logic is fully
//! deterministic and unit-testable; the `realtime` crate drives it with real
//! time inside a per-game async task.

use std::collections::HashMap;

use protocol::{Clock, Color, GameEndReason, GameResult, TimeControl};
use shakmaty::fen::Fen;
use shakmaty::san::San;
use shakmaty::uci::UciMove;
use shakmaty::{Chess, EnPassantMode, Position};
use thiserror::Error;

/// Grace added to a side's remaining time before flagging, to absorb network
/// and IPC latency. A conservative server policy knob (see plan §clock authority).
pub const LAG_ALLOWANCE_MS: u64 = 150;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum MoveError {
    #[error("game is already over")]
    GameOver,
    #[error("could not parse UCI move '{0}'")]
    BadUci(String),
    #[error("illegal move '{0}' in this position")]
    Illegal(String),
}

/// Current lifecycle of a game.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Ongoing,
    Finished(GameResult),
}

/// The result of successfully applying a move.
#[derive(Debug, Clone)]
pub struct MoveApplied {
    pub ply: u32,
    pub san: String,
    pub clock: Clock,
    /// `Some` if this move ended the game.
    pub result: Option<GameResult>,
}

/// One authoritative chess game with a server-side clock.
pub struct Game {
    pos: Chess,
    start_fen: String,
    moves_uci: Vec<String>,
    san_log: Vec<String>,
    time_control: TimeControl,
    white_ms: u64,
    black_ms: u64,
    /// Server time (ms) at which the side-to-move's clock started ticking.
    turn_started_ms: u64,
    ply: u32,
    status: Status,
    /// Repetition counter keyed by the repetition-relevant FEN fields.
    rep: HashMap<String, u8>,
}

impl Game {
    /// Start a new game from the initial position. `now_ms` is the server time
    /// at which White's clock begins.
    pub fn new(time_control: TimeControl, now_ms: u64) -> Self {
        let pos = Chess::default();
        let start_fen = fen_string(&pos);
        let mut rep = HashMap::new();
        rep.insert(repetition_key(&start_fen), 1);
        Game {
            pos,
            start_fen,
            moves_uci: Vec::new(),
            san_log: Vec::new(),
            time_control,
            white_ms: time_control.initial_ms,
            black_ms: time_control.initial_ms,
            turn_started_ms: now_ms,
            ply: 0,
            status: Status::Ongoing,
            rep,
        }
    }

    pub fn status(&self) -> Status {
        self.status
    }

    pub fn result(&self) -> Option<GameResult> {
        match self.status {
            Status::Finished(r) => Some(r),
            Status::Ongoing => None,
        }
    }

    pub fn is_over(&self) -> bool {
        matches!(self.status, Status::Finished(_))
    }

    /// The side to move.
    pub fn turn(&self) -> Color {
        to_proto_color(self.pos.turn())
    }

    pub fn ply(&self) -> u32 {
        self.ply
    }

    pub fn start_fen(&self) -> &str {
        &self.start_fen
    }

    /// Current position FEN.
    pub fn fen(&self) -> String {
        fen_string(&self.pos)
    }

    /// Full move history in UCI long-algebraic notation.
    pub fn moves_uci(&self) -> &[String] {
        &self.moves_uci
    }

    /// Minimal PGN movetext (no headers): "1. e4 e5 2. Nf3 ...".
    pub fn pgn(&self) -> String {
        let mut out = String::new();
        for (i, san) in self.san_log.iter().enumerate() {
            if i % 2 == 0 {
                if i > 0 {
                    out.push(' ');
                }
                out.push_str(&format!("{}. {}", i / 2 + 1, san));
            } else {
                out.push(' ');
                out.push_str(san);
            }
        }
        out
    }

    /// The live clock, accounting for time elapsed on the side to move since
    /// its turn began.
    pub fn clock(&self, now_ms: u64) -> Clock {
        let elapsed = now_ms.saturating_sub(self.turn_started_ms);
        let (white_ms, black_ms) = match self.pos.turn() {
            shakmaty::Color::White => (self.white_ms.saturating_sub(elapsed), self.black_ms),
            shakmaty::Color::Black => (self.white_ms, self.black_ms.saturating_sub(elapsed)),
        };
        Clock {
            white_ms,
            black_ms,
            increment_ms: self.time_control.increment_ms,
        }
    }

    /// If the side to move has run out of time (beyond the lag allowance), end
    /// the game on time and return the result. Idempotent once finished.
    pub fn flag_if_expired(&mut self, now_ms: u64) -> Option<GameResult> {
        if self.is_over() {
            return self.result();
        }
        let elapsed = now_ms.saturating_sub(self.turn_started_ms);
        let remaining = self.remaining_for_turn();
        if elapsed > remaining + LAG_ALLOWANCE_MS {
            // The side to move flagged. Opponent wins unless they cannot mate.
            let flagged = self.turn();
            let result = if self.pos.is_insufficient_material() {
                GameResult {
                    winner: None,
                    reason: GameEndReason::Timeout,
                }
            } else {
                GameResult {
                    winner: Some(flagged.opposite()),
                    reason: GameEndReason::Timeout,
                }
            };
            self.finish(result);
            return Some(result);
        }
        None
    }

    /// Resign the game on behalf of `who`.
    pub fn resign(&mut self, who: Color) -> Option<GameResult> {
        if self.is_over() {
            return self.result();
        }
        let result = GameResult {
            winner: Some(who.opposite()),
            reason: GameEndReason::Resignation,
        };
        self.finish(result);
        Some(result)
    }

    /// Validate and apply a move for the side to move at server time `now_ms`.
    ///
    /// The caller is responsible for ensuring the move came from the player
    /// whose turn it is; this method only checks legality, timing, and terminal
    /// conditions.
    pub fn play_move(&mut self, uci_move: &str, now_ms: u64) -> Result<MoveApplied, MoveError> {
        if self.is_over() {
            return Err(MoveError::GameOver);
        }

        // Clock first: a move that arrives after the flag does not count.
        if let Some(result) = self.flag_if_expired(now_ms) {
            return Ok(MoveApplied {
                ply: self.ply,
                san: String::new(),
                clock: self.frozen_clock(),
                result: Some(result),
            });
        }

        let uci: UciMove = uci_move
            .parse()
            .map_err(|_| MoveError::BadUci(uci_move.to_string()))?;
        let mv = uci
            .to_move(&self.pos)
            .map_err(|_| MoveError::Illegal(uci_move.to_string()))?;

        // Record SAN against the pre-move position, then apply.
        let san = San::from_move(&self.pos, &mv).to_string();
        let mover = self.pos.turn();
        let new_pos = self
            .pos
            .clone()
            .play(&mv)
            .map_err(|_| MoveError::Illegal(uci_move.to_string()))?;
        self.pos = new_pos;

        // Charge the clock: deduct elapsed, add increment.
        let elapsed = now_ms.saturating_sub(self.turn_started_ms);
        match mover {
            shakmaty::Color::White => {
                self.white_ms = self.white_ms.saturating_sub(elapsed) + self.time_control.increment_ms;
            }
            shakmaty::Color::Black => {
                self.black_ms = self.black_ms.saturating_sub(elapsed) + self.time_control.increment_ms;
            }
        }
        self.turn_started_ms = now_ms;
        self.ply += 1;
        self.moves_uci.push(uci_move.to_string());
        self.san_log.push(san.clone());

        // Terminal detection.
        let result = self.detect_terminal();
        if let Some(r) = result {
            self.finish(r);
        }

        Ok(MoveApplied {
            ply: self.ply,
            san,
            clock: self.frozen_clock(),
            result,
        })
    }

    // -- internals ---------------------------------------------------------

    fn remaining_for_turn(&self) -> u64 {
        match self.pos.turn() {
            shakmaty::Color::White => self.white_ms,
            shakmaty::Color::Black => self.black_ms,
        }
    }

    /// Clock snapshot using stored balances (no live elapsed) — used right after
    /// a move is applied / the game is frozen.
    fn frozen_clock(&self) -> Clock {
        Clock {
            white_ms: self.white_ms,
            black_ms: self.black_ms,
            increment_ms: self.time_control.increment_ms,
        }
    }

    fn finish(&mut self, result: GameResult) {
        self.status = Status::Finished(result);
    }

    fn detect_terminal(&mut self) -> Option<GameResult> {
        if self.pos.is_checkmate() {
            // The side that just moved delivered mate; it is now the loser's turn.
            let loser = self.turn();
            return Some(GameResult {
                winner: Some(loser.opposite()),
                reason: GameEndReason::Checkmate,
            });
        }
        if self.pos.is_stalemate() {
            return Some(GameResult {
                winner: None,
                reason: GameEndReason::Stalemate,
            });
        }
        if self.pos.is_insufficient_material() {
            return Some(GameResult {
                winner: None,
                reason: GameEndReason::InsufficientMaterial,
            });
        }
        if self.pos.halfmoves() >= 100 {
            return Some(GameResult {
                winner: None,
                reason: GameEndReason::FiftyMoveRule,
            });
        }
        // Threefold repetition.
        let key = repetition_key(&fen_string(&self.pos));
        let count = self.rep.entry(key).or_insert(0);
        *count += 1;
        if *count >= 3 {
            return Some(GameResult {
                winner: None,
                reason: GameEndReason::Threefold,
            });
        }
        None
    }
}

fn to_proto_color(c: shakmaty::Color) -> Color {
    match c {
        shakmaty::Color::White => Color::White,
        shakmaty::Color::Black => Color::Black,
    }
}

fn fen_string(pos: &Chess) -> String {
    Fen::from_position(pos.clone(), EnPassantMode::Legal).to_string()
}

/// The repetition-relevant prefix of a FEN: piece placement, side to move,
/// castling rights, and en-passant square (drops the halfmove/fullmove clocks).
fn repetition_key(fen: &str) -> String {
    fen.split_whitespace()
        .take(4)
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    const TC: TimeControl = TimeControl {
        initial_ms: 60_000,
        increment_ms: 1_000,
    };

    #[test]
    fn scholars_mate_is_checkmate_white_wins() {
        let mut g = Game::new(TC, 0);
        // 1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6?? 4. Qxf7#
        let moves = ["e2e4", "e7e5", "f1c4", "b8c6", "d1h5", "g8f6", "h5f7"];
        let mut now = 0;
        let mut last = None;
        for m in moves {
            now += 1_000; // each side uses 1s
            last = Some(g.play_move(m, now).expect("legal move"));
        }
        let applied = last.unwrap();
        let result = applied.result.expect("game should be over");
        assert_eq!(result.reason, GameEndReason::Checkmate);
        assert_eq!(result.winner, Some(Color::White));
        assert!(g.is_over());
    }

    #[test]
    fn illegal_move_is_rejected_and_game_continues() {
        let mut g = Game::new(TC, 0);
        let err = g.play_move("e2e5", 1_000).unwrap_err();
        assert_eq!(err, MoveError::Illegal("e2e5".into()));
        assert!(!g.is_over());
        // a legal move still works afterwards
        assert!(g.play_move("e2e4", 2_000).is_ok());
    }

    #[test]
    fn flag_on_time_loses() {
        let mut g = Game::new(TC, 0);
        // White makes a move quickly.
        g.play_move("e2e4", 500).unwrap();
        // Black is to move with 60s; let way more than that elapse.
        let result = g.flag_if_expired(500 + 60_000 + LAG_ALLOWANCE_MS + 1).unwrap();
        assert_eq!(result.reason, GameEndReason::Timeout);
        assert_eq!(result.winner, Some(Color::White));
    }

    #[test]
    fn increment_is_added_after_move() {
        let mut g = Game::new(TC, 0);
        // White uses 2s on the first move; should get 1s increment back.
        let applied = g.play_move("e2e4", 2_000).unwrap();
        assert_eq!(applied.clock.white_ms, 60_000 - 2_000 + 1_000);
        assert_eq!(applied.clock.black_ms, 60_000);
    }

    #[test]
    fn resignation_awards_opponent() {
        let mut g = Game::new(TC, 0);
        let r = g.resign(Color::Black).unwrap();
        assert_eq!(r.winner, Some(Color::White));
        assert_eq!(r.reason, GameEndReason::Resignation);
        assert!(g.is_over());
    }

    #[test]
    fn pgn_movetext_is_formatted() {
        let mut g = Game::new(TC, 0);
        g.play_move("e2e4", 1_000).unwrap();
        g.play_move("e7e5", 2_000).unwrap();
        g.play_move("g1f3", 3_000).unwrap();
        assert_eq!(g.pgn(), "1. e4 e5 2. Nf3");
    }
}
