//! Per-game actor: owns the authoritative `Game`, drives the turn loop, and
//! fans messages out to the two players and any spectators.
//!
//! One `run_room` task exists per live game. All game state lives inside this
//! task, so there are no locks on the hot path and move ordering is serialized
//! by the command channel.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use sha2::{Digest, Sha256};

use game_engine::{Game, MoveApplied, MoveError, LAG_ALLOWANCE_MS};
use ledger::{Address, SettlementSink};
use persistence::Db;
use protocol::{Color, GameEndReason, GameResult, ServerMessage, TimeControl};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio::time::{interval, Instant};

/// On-chain seats for a wagered game (used to settle the result).
#[derive(Clone, Copy)]
pub struct StakeInfo {
    pub white: Address,
    pub black: Address,
}

/// Commands accepted by a room from the WebSocket layer.
pub enum RoomCmd {
    /// A player connection attaches to its seat. `resp` replies `true` if the
    /// seat was free (attached) or `false` if already occupied by a live
    /// connection (rejected — prevents concurrent seat hijack).
    AttachPlayer {
        color: Color,
        out: mpsc::Sender<ServerMessage>,
        resp: oneshot::Sender<bool>,
    },
    /// A player connection dropped; free the seat so a reconnect can re-attach.
    Detach { color: Color },
    /// A player signalled its engine is ready.
    Ready { color: Color },
    /// A player submitted a move.
    Move {
        color: Color,
        ply: u32,
        uci_move: String,
    },
    /// A player resigned.
    Resign { color: Color },
    /// A spectator joined: reply with the current game state so it can rebuild
    /// the board from the full move history (it otherwise only sees new moves).
    Snapshot { resp: oneshot::Sender<Snapshot> },
}

/// Current game state for a mid-join spectator.
pub struct Snapshot {
    pub started: bool,
    pub start_fen: String,
    pub moves_uci: Vec<String>,
    pub clock: protocol::Clock,
}

pub struct RoomHandle {
    pub cmd_tx: mpsc::Sender<RoomCmd>,
    pub spectate_tx: broadcast::Sender<ServerMessage>,
    /// True once the game has actually begun (both engines ready). Lets the
    /// lobby list only in-progress games, not idle rooms awaiting connections.
    pub started: Arc<AtomicBool>,
}

/// Spawn a room task and return a handle for the HTTP/WS layer.
pub fn spawn_room(
    game_id: protocol::GameId,
    tc: TimeControl,
    settlement: Arc<dyn SettlementSink>,
    stake: Option<StakeInfo>,
    players: [protocol::OpponentInfo; 2], // [white, black] display identity
    db: Option<Arc<Db>>,
    cleanup_tx: mpsc::Sender<protocol::GameId>,
    results_tx: mpsc::Sender<crate::GameOutcome>,
) -> RoomHandle {
    let (cmd_tx, cmd_rx) = mpsc::channel(64);
    let (spectate_tx, _) = broadcast::channel(256);
    // Shared with the RoomHandle so the lobby can list only games that have
    // actually begun (both engines connected + ready), not idle/ghost rooms.
    let started_flag = Arc::new(AtomicBool::new(false));
    let room = Room {
        game_id,
        tc,
        game: None,
        white_out: None,
        black_out: None,
        white_occupied: false,
        black_occupied: false,
        wready: false,
        bready: false,
        started: false,
        started_flag: started_flag.clone(),
        spectate: spectate_tx.clone(),
        base: Instant::now(),
        settlement,
        stake,
        players,
        db,
        cleanup_tx,
        results_tx,
    };
    tokio::spawn(room.run(cmd_rx));
    RoomHandle {
        cmd_tx,
        spectate_tx,
        started: started_flag,
    }
}

struct Room {
    game_id: protocol::GameId,
    tc: TimeControl,
    game: Option<Game>,
    white_out: Option<mpsc::Sender<ServerMessage>>,
    black_out: Option<mpsc::Sender<ServerMessage>>,
    white_occupied: bool,
    black_occupied: bool,
    wready: bool,
    bready: bool,
    started: bool,
    started_flag: Arc<AtomicBool>,
    spectate: broadcast::Sender<ServerMessage>,
    base: Instant,
    settlement: Arc<dyn SettlementSink>,
    stake: Option<StakeInfo>,
    /// [white, black] display identity, shown to each player's opponent.
    players: [protocol::OpponentInfo; 2],
    db: Option<Arc<Db>>,
    cleanup_tx: mpsc::Sender<protocol::GameId>,
    results_tx: mpsc::Sender<crate::GameOutcome>,
}

impl Room {
    fn now_ms(&self) -> u64 {
        self.base.elapsed().as_millis() as u64
    }

    async fn send_to(&self, color: Color, msg: ServerMessage) {
        let out = match color {
            Color::White => &self.white_out,
            Color::Black => &self.black_out,
        };
        if let Some(tx) = out {
            let _ = tx.send(msg).await;
        }
    }

    /// Send to both players and all spectators.
    async fn send_all(&self, msg: ServerMessage) {
        self.send_to(Color::White, msg.clone()).await;
        self.send_to(Color::Black, msg.clone()).await;
        let _ = self.spectate.send(msg);
    }

    async fn run(mut self, mut cmd_rx: mpsc::Receiver<RoomCmd>) {
        let mut tick = interval(Duration::from_millis(250));
        loop {
            tokio::select! {
                cmd = cmd_rx.recv() => {
                    match cmd {
                        None => break,
                        Some(cmd) => self.handle(cmd).await,
                    }
                }
                _ = tick.tick() => {
                    self.on_tick().await;
                }
            }
            // Stop once the game is finished and the result has been delivered.
            if self.started && self.game.as_ref().map(|g| g.is_over()).unwrap_or(false) {
                // Keep the task alive briefly so spectators can catch GameOver,
                // then exit. For the slice we simply break.
                break;
            }
            // Reap a room that never begins (engines never both readied) so it
            // doesn't linger forever as a ghost in the lobby's "live" list.
            // Resolve it as a forfeit: the side that showed up and readied wins;
            // if neither did, it's a draw. Routing through `finish()` settles a
            // wagered escrow on-chain NOW — the stake goes to the player who
            // showed up (or both are refunded if nobody did) instead of sitting
            // locked behind the contract's 24h `claimTimeout` — tells that
            // player they won, and keeps mode standings progressing.
            if !self.started && self.base.elapsed() > Duration::from_secs(60) {
                let winner = reap_forfeit_winner(
                    self.white_occupied,
                    self.wready,
                    self.black_occupied,
                    self.bready,
                );
                let reason = if winner.is_some() {
                    GameEndReason::Forfeit
                } else {
                    GameEndReason::Aborted
                };
                tracing::info!(game_id = %self.game_id, ?winner, "room reaped: never started");
                self.finish(GameResult { winner, reason }).await;
                break;
            }
        }
        tracing::info!(game_id = %self.game_id, "room closed");
        // Signal the server to evict this game's room handle + launch tokens.
        let _ = self.cleanup_tx.send(self.game_id).await;
    }

    async fn on_tick(&mut self) {
        if !self.started {
            return;
        }
        let now = self.now_ms();
        let mut over = None;
        if let Some(game) = self.game.as_mut() {
            if !game.is_over() {
                if let Some(result) = game.flag_if_expired(now) {
                    over = Some(result);
                } else {
                    // periodic clock sync to spectators
                    let clock = game.clock(now);
                    let _ = self.spectate.send(ServerMessage::ClockSync {
                        game_id: self.game_id,
                        clock,
                        server_time_ms: now,
                    });
                }
            }
        }
        if let Some(result) = over {
            self.finish(result).await;
        }
    }

    async fn handle(&mut self, cmd: RoomCmd) {
        match cmd {
            RoomCmd::AttachPlayer { color, out, resp } => {
                let occupied = match color {
                    Color::White => self.white_occupied,
                    Color::Black => self.black_occupied,
                };
                if occupied {
                    let _ = resp.send(false);
                    tracing::warn!(game_id = %self.game_id, ?color, "rejected attach: seat occupied");
                    return;
                }
                match color {
                    Color::White => {
                        self.white_out = Some(out);
                        self.white_occupied = true;
                    }
                    Color::Black => {
                        self.black_out = Some(out);
                        self.black_occupied = true;
                    }
                }
                let _ = resp.send(true);
                tracing::info!(game_id = %self.game_id, ?color, "player attached");
                // Reconnection: if the game is already live, resend current state.
                if self.started && !self.game.as_ref().map(|g| g.is_over()).unwrap_or(true) {
                    self.resend_state(color).await;
                }
            }
            RoomCmd::Detach { color } => {
                match color {
                    Color::White => {
                        self.white_occupied = false;
                        self.white_out = None;
                    }
                    Color::Black => {
                        self.black_occupied = false;
                        self.black_out = None;
                    }
                }
                tracing::info!(game_id = %self.game_id, ?color, "player detached");
            }
            RoomCmd::Ready { color } => {
                match color {
                    Color::White => self.wready = true,
                    Color::Black => self.bready = true,
                }
                if self.wready && self.bready && !self.started {
                    self.start().await;
                }
            }
            RoomCmd::Move {
                color,
                ply: _,
                uci_move,
            } => {
                self.on_move(color, &uci_move).await;
            }
            RoomCmd::Resign { color } => {
                if let Some(game) = self.game.as_mut() {
                    if let Some(result) = game.resign(color) {
                        self.finish(result).await;
                    }
                }
            }
            RoomCmd::Snapshot { resp } => {
                let snap = match self.game.as_ref() {
                    Some(g) => Snapshot {
                        started: true,
                        start_fen: g.start_fen().to_string(),
                        moves_uci: g.moves_uci().to_vec(),
                        clock: g.clock(self.now_ms()),
                    },
                    None => Snapshot {
                        started: false,
                        start_fen: String::new(),
                        moves_uci: Vec::new(),
                        clock: protocol::Clock {
                            white_ms: self.tc.initial_ms,
                            black_ms: self.tc.initial_ms,
                            increment_ms: self.tc.increment_ms,
                        },
                    },
                };
                let _ = resp.send(snap);
            }
        }
    }

    async fn start(&mut self) {
        let now = self.now_ms();
        let game = Game::new(self.tc, now);
        let clock = game.clock(now);
        let start_fen = game.start_fen().to_string();
        self.game = Some(game);
        self.started = true;
        self.started_flag.store(true, Ordering::Relaxed);

        if let Some(db) = &self.db {
            let _ = db.set_game_active(self.game_id).await;
        }

        // Tell each player which color they are (and who they're facing).
        self.send_to(
            Color::White,
            ServerMessage::GameStart {
                game_id: self.game_id,
                start_fen: start_fen.clone(),
                your_color: Color::White,
                clock,
                opponent: Some(self.players[1].clone()),
            },
        )
        .await;
        self.send_to(
            Color::Black,
            ServerMessage::GameStart {
                game_id: self.game_id,
                start_fen: start_fen.clone(),
                your_color: Color::Black,
                clock,
                opponent: Some(self.players[0].clone()),
            },
        )
        .await;
        let _ = self.spectate.send(ServerMessage::GameStart {
            game_id: self.game_id,
            start_fen,
            your_color: Color::White,
            clock,
            opponent: None,
        });

        self.prompt_turn().await;
    }

    /// Resend current game state to a (re)connecting player.
    async fn resend_state(&self, color: Color) {
        let now = self.now_ms();
        let Some(game) = self.game.as_ref() else {
            return;
        };
        let clock = game.clock(now);
        let opp_idx = match color {
            Color::White => 1,
            Color::Black => 0,
        };
        self.send_to(
            color,
            ServerMessage::GameStart {
                game_id: self.game_id,
                start_fen: game.start_fen().to_string(),
                your_color: color,
                clock,
                opponent: Some(self.players[opp_idx].clone()),
            },
        )
        .await;
        if game.turn() == color {
            let remaining = match color {
                Color::White => clock.white_ms,
                Color::Black => clock.black_ms,
            };
            self.send_to(
                color,
                ServerMessage::YourTurn {
                    game_id: self.game_id,
                    ply: game.ply(),
                    position_fen: game.fen(),
                    moves_uci: game.moves_uci().to_vec(),
                    clock,
                    deadline_server_ms: now + remaining + LAG_ALLOWANCE_MS,
                },
            )
            .await;
        }
    }

    /// Ask the side to move for its move.
    async fn prompt_turn(&self) {
        let now = self.now_ms();
        let Some(game) = self.game.as_ref() else {
            return;
        };
        if game.is_over() {
            return;
        }
        let turn = game.turn();
        let clock = game.clock(now);
        let remaining = match turn {
            Color::White => clock.white_ms,
            Color::Black => clock.black_ms,
        };
        let msg = ServerMessage::YourTurn {
            game_id: self.game_id,
            ply: game.ply(),
            position_fen: game.fen(),
            moves_uci: game.moves_uci().to_vec(),
            clock,
            deadline_server_ms: now + remaining + LAG_ALLOWANCE_MS,
        };
        self.send_to(turn, msg).await;
    }

    async fn on_move(&mut self, color: Color, uci_move: &str) {
        let now = self.now_ms();
        // Validate it's this player's turn and the game is live, resolving the
        // mutable borrow on `self.game` before any further `self` method calls.
        enum Step {
            Ignore,
            Reject(u32, &'static str),
            Applied(Color, Result<MoveApplied, MoveError>),
        }
        let step = {
            match self.game.as_mut() {
                None => Step::Ignore,
                Some(game) if game.is_over() => Step::Ignore,
                Some(game) => {
                    let turn = game.turn();
                    if color != turn {
                        Step::Reject(game.ply(), "not your turn")
                    } else {
                        Step::Applied(turn, game.play_move(uci_move, now))
                    }
                }
            }
        };

        let (turn, applied) = match step {
            Step::Ignore => return,
            Step::Reject(ply, reason) => {
                self.maybe_reject(color, ply, reason).await;
                return;
            }
            Step::Applied(turn, result) => (turn, result),
        };

        match applied {
            Ok(applied) => {
                // Ack to mover.
                self.send_to(
                    turn,
                    ServerMessage::MoveAccepted {
                        game_id: self.game_id,
                        ply: applied.ply,
                        clock: applied.clock,
                    },
                )
                .await;
                // Mirror to opponent + spectators.
                let mirror = ServerMessage::OpponentMoved {
                    game_id: self.game_id,
                    ply: applied.ply,
                    uci: uci_move.to_string(),
                    clock: applied.clock,
                };
                self.send_to(turn.opposite(), mirror.clone()).await;
                let _ = self.spectate.send(mirror);

                if let Some(db) = &self.db {
                    let _ = db
                        .append_move(
                            self.game_id,
                            applied.ply as i32,
                            uci_move,
                            &applied.san,
                            applied.clock.white_ms as i64,
                            applied.clock.black_ms as i64,
                        )
                        .await;
                }

                match applied.result {
                    Some(result) => self.finish(result).await,
                    None => self.prompt_turn().await,
                }
            }
            Err(e) => {
                let ply = self.game.as_ref().map(|g| g.ply()).unwrap_or(0);
                self.send_to(
                    color,
                    ServerMessage::MoveRejected {
                        game_id: self.game_id,
                        ply,
                        reason: e.to_string(),
                    },
                )
                .await;
            }
        }
    }

    async fn maybe_reject(&self, color: Color, ply: u32, reason: &str) {
        self.send_to(
            color,
            ServerMessage::MoveRejected {
                game_id: self.game_id,
                ply,
                reason: reason.to_string(),
            },
        )
        .await;
    }

    async fn finish(&mut self, result: GameResult) {
        // A never-started game (a no-show forfeit / abort reaped in `run`) has
        // no board: settle with an empty move log and ply 0 (never rated).
        let (pgn, ply) = match self.game.as_ref() {
            Some(game) => (game.pgn(), game.ply()),
            None => (String::new(), 0),
        };
        // A game is only rated if it was actually contested — both sides must
        // have made at least one move (ply >= 2). A player who never moves (a
        // no-show, or an engine that connects then hangs and flags) still LOSES
        // the game/stake, but their Elo is untouched. Applies to every mode.
        let rated = ply >= 2;
        // Cryptographic commitment to the full game (move log via PGN).
        let result_hash = sha256_hex(&pgn);
        let (result_str, reason_str) = result_strings(&result);
        let wagered = self.stake.is_some();
        let winner_addr: Option<String> = self.stake.and_then(|stake| match result.winner {
            Some(Color::White) => Some(stake.white.to_string()),
            Some(Color::Black) => Some(stake.black.to_string()),
            None => None, // wagered draw → null winner (refund both)
        });

        match &self.db {
            // Durable, crash-safe path: persist result + (if wagered) enqueue
            // settlement in a single transaction. A worker drains the outbox.
            Some(db) => {
                if let Err(e) = db
                    .finish_and_enqueue(
                        self.game_id,
                        result_str,
                        reason_str,
                        &result_hash,
                        &pgn,
                        winner_addr.as_deref(),
                        wagered,
                    )
                    .await
                {
                    tracing::error!(game_id = %self.game_id, "finish_and_enqueue failed: {e:#}");
                }
                // Update Elo for contested games with two known wallets (no-op
                // otherwise). Skipped when a player never moved (see `rated`).
                if rated {
                    let _ = db.update_ratings(self.game_id).await;
                }
            }
            // No database: best-effort inline settle for a wagered game.
            None => {
                if let Some(stake) = self.stake {
                    let winner = match result.winner {
                        Some(Color::White) => Some(stake.white),
                        Some(Color::Black) => Some(stake.black),
                        None => None,
                    };
                    if let Err(e) = self.settlement.report_result(self.game_id, winner).await {
                        tracing::error!(game_id = %self.game_id, "settlement failed: {e:#}");
                    }
                } else {
                    tracing::info!(game_id = %self.game_id, ?result, result_hash, "unwagered game finished");
                }
            }
        }

        // Report the outcome to the server so modes (gauntlet/tournament) can
        // update standings.
        let _ = self
            .results_tx
            .send(crate::GameOutcome {
                game_id: self.game_id,
                winner: result.winner,
                plies: ply,
                // Readiness is latched (set once on Ready, never cleared), so it
                // records that a seat's engine came alive — a seat that readied
                // then briefly dropped its socket still counts as having shown
                // up. Only a seat that NEVER readies (dead/hung at init) is a
                // no-show. Do not AND in `occupied`: a transient disconnect must
                // not be mistaken for a no-show.
                white_showed_up: self.wready,
                black_showed_up: self.bready,
            })
            .await;

        // Oracle-sign the result commitment so clients can verify it.
        let server_sig = self.settlement.sign_result(&result_hash).await;

        self.send_all(ServerMessage::GameOver {
            game_id: self.game_id,
            result,
            final_pgn: pgn,
            result_hash,
            server_sig,
        })
        .await;
    }
}

/// Resolve a never-started game reaped from the lobby. Forfeit the whole stake
/// to a side ONLY when it actually showed up (still connected AND readied) while
/// its opponent is a genuine no-show (not connected). Every ambiguous case —
/// nobody ready, both still connected but one slow to ready, or a side that
/// readied then dropped its connection — is a draw / refund, never a
/// confiscation of a present player's stake. (Both sides connected + ready
/// can't reach the reap: the `Ready` handler would have started the game.)
fn reap_forfeit_winner(
    white_occupied: bool,
    white_ready: bool,
    black_occupied: bool,
    black_ready: bool,
) -> Option<Color> {
    let white_showed = white_occupied && white_ready;
    let black_showed = black_occupied && black_ready;
    if white_showed && !black_occupied {
        Some(Color::White)
    } else if black_showed && !white_occupied {
        Some(Color::Black)
    } else {
        None
    }
}

fn result_strings(r: &GameResult) -> (&'static str, &'static str) {
    let winner = match r.winner {
        Some(Color::White) => "white",
        Some(Color::Black) => "black",
        None => "draw",
    };
    let reason = match r.reason {
        GameEndReason::Checkmate => "checkmate",
        GameEndReason::Resignation => "resignation",
        GameEndReason::Timeout => "timeout",
        GameEndReason::Stalemate => "stalemate",
        GameEndReason::InsufficientMaterial => "insufficient_material",
        GameEndReason::FiftyMoveRule => "fifty_move",
        GameEndReason::Threefold => "threefold",
        GameEndReason::Aborted => "aborted",
        GameEndReason::Forfeit => "forfeit",
    };
    (winner, reason)
}

fn sha256_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    hex_encode(&h.finalize())
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_show_forfeits_to_the_present_ready_side() {
        // White connected + ready, Black never connected → White wins by
        // forfeit and takes the stake. Symmetric for Black.
        assert_eq!(reap_forfeit_winner(true, true, false, false), Some(Color::White));
        assert_eq!(reap_forfeit_winner(false, false, true, true), Some(Color::Black));
    }

    #[test]
    fn ambiguous_reap_refunds_instead_of_confiscating() {
        // Nobody readied → draw / refund both.
        assert_eq!(reap_forfeit_winner(true, false, true, false), None);
        // A present but slow-to-ready opponent is NOT confiscated: White ready,
        // Black still connected but not yet ready → refund, not a White forfeit.
        assert_eq!(reap_forfeit_winner(true, true, true, false), None);
        // A side that readied then DISCONNECTED can't win over a present
        // opponent: White readied then dropped (not connected), Black present
        // but not ready → refund, and the absent White is never paid.
        assert_eq!(reap_forfeit_winner(false, true, true, false), None);
        // Neither connected → refund.
        assert_eq!(reap_forfeit_winner(false, false, false, false), None);
    }
}
