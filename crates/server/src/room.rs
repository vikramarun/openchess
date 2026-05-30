//! Per-game actor: owns the authoritative `Game`, drives the turn loop, and
//! fans messages out to the two players and any spectators.
//!
//! One `run_room` task exists per live game. All game state lives inside this
//! task, so there are no locks on the hot path and move ordering is serialized
//! by the command channel.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use std::time::Duration;

use game_engine::{Game, MoveApplied, MoveError, LAG_ALLOWANCE_MS};
use ledger::{Address, SettlementSink};
use persistence::Db;
use protocol::{Color, GameEndReason, GameResult, ServerMessage, TimeControl};
use tokio::sync::{broadcast, mpsc};
use tokio::time::{interval, Instant};

/// On-chain seats for a wagered game (used to settle the result).
#[derive(Clone, Copy)]
pub struct StakeInfo {
    pub white: Address,
    pub black: Address,
}

/// Commands accepted by a room from the WebSocket layer.
pub enum RoomCmd {
    /// A player connection attached to its seat.
    AttachPlayer {
        color: Color,
        out: mpsc::Sender<ServerMessage>,
    },
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
}

pub struct RoomHandle {
    pub cmd_tx: mpsc::Sender<RoomCmd>,
    pub spectate_tx: broadcast::Sender<ServerMessage>,
}

/// Spawn a room task and return a handle for the HTTP/WS layer.
pub fn spawn_room(
    game_id: protocol::GameId,
    tc: TimeControl,
    settlement: Arc<dyn SettlementSink>,
    stake: Option<StakeInfo>,
    db: Option<Arc<Db>>,
) -> RoomHandle {
    let (cmd_tx, cmd_rx) = mpsc::channel(64);
    let (spectate_tx, _) = broadcast::channel(256);
    let room = Room {
        game_id,
        tc,
        game: None,
        white_out: None,
        black_out: None,
        wready: false,
        bready: false,
        started: false,
        spectate: spectate_tx.clone(),
        base: Instant::now(),
        settlement,
        stake,
        db,
    };
    tokio::spawn(room.run(cmd_rx));
    RoomHandle {
        cmd_tx,
        spectate_tx,
    }
}

struct Room {
    game_id: protocol::GameId,
    tc: TimeControl,
    game: Option<Game>,
    white_out: Option<mpsc::Sender<ServerMessage>>,
    black_out: Option<mpsc::Sender<ServerMessage>>,
    wready: bool,
    bready: bool,
    started: bool,
    spectate: broadcast::Sender<ServerMessage>,
    base: Instant,
    settlement: Arc<dyn SettlementSink>,
    stake: Option<StakeInfo>,
    db: Option<Arc<Db>>,
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
        }
        tracing::info!(game_id = %self.game_id, "room closed");
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
            RoomCmd::AttachPlayer { color, out } => {
                match color {
                    Color::White => self.white_out = Some(out),
                    Color::Black => self.black_out = Some(out),
                }
                tracing::info!(game_id = %self.game_id, ?color, "player attached");
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
        }
    }

    async fn start(&mut self) {
        let now = self.now_ms();
        let game = Game::new(self.tc, now);
        let clock = game.clock(now);
        self.game = Some(game);
        self.started = true;

        if let Some(db) = &self.db {
            let _ = db.set_game_active(self.game_id).await;
        }

        let start_fen = self.game.as_ref().unwrap().start_fen().to_string();
        // Tell each player which color they are.
        self.send_to(
            Color::White,
            ServerMessage::GameStart {
                game_id: self.game_id,
                start_fen: start_fen.clone(),
                your_color: Color::White,
                clock,
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
            },
        )
        .await;
        let _ = self.spectate.send(ServerMessage::GameStart {
            game_id: self.game_id,
            start_fen,
            your_color: Color::White,
            clock,
        });

        self.prompt_turn().await;
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
        let (pgn, clock) = {
            let game = self.game.as_ref().unwrap();
            (game.pgn(), game.clock(self.now_ms()))
        };
        let result_hash = hash_hex(&pgn);
        let (result_str, reason_str) = result_strings(&result);

        // Persist the durable result + final PGN.
        if let Some(db) = &self.db {
            let _ = db
                .finish_game(self.game_id, result_str, reason_str, &result_hash, &pgn)
                .await;
        }

        // Settlement seam. For a wagered game we prefer the durable, crash-safe
        // path: enqueue to the settlement outbox (a worker drains it on-chain).
        // With no database we settle inline as a best-effort fallback.
        if let Some(stake) = self.stake {
            let winner_addr = match result.winner {
                Some(Color::White) => Some(stake.white),
                Some(Color::Black) => Some(stake.black),
                None => None,
            };
            match &self.db {
                Some(db) => {
                    let addr_str = winner_addr.map(|a| a.to_string());
                    if let Err(e) = db
                        .enqueue_settlement(self.game_id, addr_str.as_deref())
                        .await
                    {
                        tracing::error!(game_id = %self.game_id, "enqueue settlement failed: {e:#}");
                    }
                }
                None => match self.settlement.report_result(self.game_id, winner_addr).await {
                    Ok(()) => {}
                    Err(e) => tracing::error!(game_id = %self.game_id, "settlement failed: {e:#}"),
                },
            }
        } else {
            tracing::info!(game_id = %self.game_id, ?result, result_hash, "unwagered game finished");
        }

        let _ = clock;
        self.send_all(ServerMessage::GameOver {
            game_id: self.game_id,
            result,
            final_pgn: pgn,
            result_hash,
            server_sig: None,
        })
        .await;
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
    };
    (winner, reason)
}

fn hash_hex(s: &str) -> String {
    let mut h = DefaultHasher::new();
    s.hash(&mut h);
    format!("{:016x}", h.finish())
}

