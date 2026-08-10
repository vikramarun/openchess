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
///
/// It is a TOTAL overdraft, not a per-move gift. That distinction is the whole
/// of `flag_if_expired`'s correctness: a balance that floors at zero while the
/// flag test compares against `remaining + LAG_ALLOWANCE_MS` hands the grace
/// back on every move, so a side sitting at 0ms never flags as long as each move
/// lands inside it. Measured before the fix: a 500ms clock, moves of 120ms, and
/// after 2400ms both clocks read 0 with the game still running. A bot on a fast
/// link could simply never lose on time, in a game settling real money.
pub const LAG_ALLOWANCE_MS: u64 = 150;

/// The wire clock never shows a debt — a player who overdrew is at zero as far
/// as anyone watching is concerned, and `protocol::Clock` is unsigned.
fn to_wire(ms: i64) -> u64 {
    ms.max(0) as u64
}

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
    /// SIGNED. A side that overran its clock carries the debt rather than
    /// flooring at zero: the flag test adds `LAG_ALLOWANCE_MS` to this, so a
    /// balance that could not go negative renewed the whole allowance every
    /// move. See `LAG_ALLOWANCE_MS`.
    white_ms: i64,
    black_ms: i64,
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
            white_ms: time_control.initial_ms as i64,
            black_ms: time_control.initial_ms as i64,
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
        let elapsed = now_ms.saturating_sub(self.turn_started_ms) as i64;
        let (white_ms, black_ms) = match self.pos.turn() {
            shakmaty::Color::White => (self.white_ms - elapsed, self.black_ms),
            shakmaty::Color::Black => (self.white_ms, self.black_ms - elapsed),
        };
        Clock {
            white_ms: to_wire(white_ms),
            black_ms: to_wire(black_ms),
            increment_ms: self.time_control.increment_ms,
        }
    }

    /// If the side to move has run out of time (beyond the lag allowance), end
    /// the game on time and return the result. Idempotent once finished.
    pub fn flag_if_expired(&mut self, now_ms: u64) -> Option<GameResult> {
        if self.is_over() {
            return self.result();
        }
        let elapsed = now_ms.saturating_sub(self.turn_started_ms) as i64;
        let remaining = self.remaining_for_turn();
        if elapsed > remaining + LAG_ALLOWANCE_MS as i64 {
            // The side to move flagged. Opponent wins unless they cannot mate.
            //
            // The question is about the OPPONENT's material alone (FIDE 6.9:
            // a flag is a draw when the other side cannot checkmate by any
            // series of legal moves), which is what `has_insufficient_material`
            // answers. `is_insufficient_material` is a different question — it
            // is `has_insufficient_material(White) && …(Black)`, i.e. neither
            // side can mate — and asking it here awarded the game to a lone
            // king whenever the flagging side still had material. Flagging with
            // a queen against a bare king handed that king the win, and in a
            // staked game the whole stake with it.
            let flagged = self.turn();
            let opponent = self.pos.turn().other();
            let result = if self.pos.has_insufficient_material(opponent) {
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
        // Exact, and allowed to go negative. Saturating here was the bug: it
        // erased the overdraft, so the next move's flag test started from a
        // clean zero and the allowance was granted again.
        let elapsed = now_ms.saturating_sub(self.turn_started_ms) as i64;
        let inc = self.time_control.increment_ms as i64;
        match mover {
            shakmaty::Color::White => self.white_ms = self.white_ms - elapsed + inc,
            shakmaty::Color::Black => self.black_ms = self.black_ms - elapsed + inc,
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

    fn remaining_for_turn(&self) -> i64 {
        match self.pos.turn() {
            shakmaty::Color::White => self.white_ms,
            shakmaty::Color::Black => self.black_ms,
        }
    }

    /// Clock snapshot using stored balances (no live elapsed) — used right after
    /// a move is applied / the game is frozen.
    fn frozen_clock(&self) -> Clock {
        Clock {
            white_ms: to_wire(self.white_ms),
            black_ms: to_wire(self.black_ms),
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
    fen.split_whitespace().take(4).collect::<Vec<_>>().join(" ")
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
        let result = g
            .flag_if_expired(500 + 60_000 + LAG_ALLOWANCE_MS + 1)
            .unwrap();
        assert_eq!(result.reason, GameEndReason::Timeout);
        assert_eq!(result.winner, Some(Color::White));
    }

    /// Drop a position in directly. There is no FEN constructor on `Game` (a
    /// real game always starts from the initial position), and reaching a bare
    /// king by legal moves would take fifty of them.
    fn at(fen: &str) -> Chess {
        fen.parse::<Fen>()
            .expect("valid fen")
            .into_position(shakmaty::CastlingMode::Standard)
            .expect("legal position")
    }

    #[test]
    fn flagging_against_a_bare_king_is_a_draw() {
        // FIDE 6.9: running out of time only loses if the OPPONENT can still
        // deliver mate. White is to move and up a queen; Black has a bare king
        // and cannot mate by any series of legal moves, so this is a draw —
        // and in a staked game, a refund rather than a payout to the bare king.
        let mut g = Game::new(TC, 0);
        g.pos = at("8/8/8/4k3/8/8/3Q4/4K3 w - - 0 1");

        let result = g.flag_if_expired(60_000 + LAG_ALLOWANCE_MS + 1).unwrap();
        assert_eq!(result.reason, GameEndReason::Timeout);
        assert_eq!(result.winner, None);
    }

    #[test]
    fn flagging_against_mating_material_still_loses() {
        // The other half: the guard asks about the opponent's material only,
        // so a bare king that flags against a queen loses exactly as before.
        let mut g = Game::new(TC, 0);
        g.pos = at("8/8/8/4k3/8/8/1q6/4K3 w - - 0 1");

        let result = g.flag_if_expired(60_000 + LAG_ALLOWANCE_MS + 1).unwrap();
        assert_eq!(result.reason, GameEndReason::Timeout);
        assert_eq!(result.winner, Some(Color::Black));
    }

    #[test]
    fn an_empty_clock_cannot_be_played_through() {
        // The bug this exists for: the balance floored at zero while the flag
        // test compared against `remaining + LAG_ALLOWANCE_MS`, so the grace was
        // handed back on every move and a side at 0ms never flagged as long as
        // each move landed inside it. Nothing about that is rare — it is a bot
        // on a fast link deciding never to lose on time, for real money.
        //
        // 500ms each, moves of 120ms (comfortably under the allowance). Twenty
        // plies is 1200ms a side against a 500ms clock, so somebody has to flag.
        let tc = TimeControl {
            initial_ms: 500,
            increment_ms: 0,
        };
        let mut g = Game::new(tc, 0);
        let moves = [
            "e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "d2d3", "f8c5", "c1g5", "d7d6", "b1c3",
            "c8g4", "h2h3", "g4h5", "g5f6", "d8f6", "c3d5", "f6d8", "c2c3", "a7a6",
        ];
        let mut now = 0u64;
        let mut ended_at = None;
        for (i, m) in moves.iter().enumerate() {
            now += 120;
            match g.play_move(m, now) {
                Ok(a) => {
                    if a.result.is_some() {
                        ended_at = Some(i);
                        break;
                    }
                }
                // Once the game is over the room stops accepting moves; either
                // shape counts as "the clock was enforced".
                Err(MoveError::GameOver) => {
                    ended_at = Some(i);
                    break;
                }
                Err(e) => panic!("unexpected rejection at ply {i}: {e:?}"),
            }
        }
        assert!(
            ended_at.is_some(),
            "nobody flagged after {now}ms of a 500ms clock",
        );
        assert_eq!(g.result().map(|r| r.reason), Some(GameEndReason::Timeout));
    }

    #[test]
    fn the_lag_allowance_is_a_total_overdraft_not_a_per_move_gift() {
        // It still absorbs a single late arrival, which is what it is for...
        let tc = TimeControl {
            initial_ms: 1_000,
            increment_ms: 0,
        };
        let mut g = Game::new(tc, 0);
        g.play_move("e2e4", 1_100).expect("100ms over is forgiven");
        assert!(!g.is_over());

        // ...and the overdraft is now CARRIED, so the next move starts from a
        // debt rather than a fresh zero. White is 100ms down with 50ms of
        // allowance left, so a second 100ms overrun ends it. Before the fix the
        // allowance reset here and White could do this forever.
        g.play_move("e7e5", 1_200).expect("black still has time");
        let result = g.flag_if_expired(1_200 + 60).expect("white is out of road");
        assert_eq!(result.reason, GameEndReason::Timeout);
        assert_eq!(result.winner, Some(Color::Black));
    }

    #[test]
    fn a_wire_clock_never_reports_a_debt() {
        // `protocol::Clock` is unsigned and a spectator should never see a
        // negative number; the debt is internal bookkeeping only.
        let tc = TimeControl {
            initial_ms: 1_000,
            increment_ms: 0,
        };
        let mut g = Game::new(tc, 0);
        let applied = g.play_move("e2e4", 1_100).unwrap();
        assert_eq!(applied.clock.white_ms, 0);
        assert_eq!(g.clock(1_100).white_ms, 0);
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
