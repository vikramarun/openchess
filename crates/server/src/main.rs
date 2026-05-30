//! Chess game server: HTTP for game creation + matchmaking (Park/Patzer,
//! Gauntlet queue, Tournament) and a WebSocket hub connecting bring-your-own-
//! engine player clients and spectators to per-game room actors.
//!
//! Durable state (games, moves, results) is persisted to Postgres when
//! `DATABASE_URL` is set; lobby/matchmaking state is in-memory (the Redis layer
//! in production). On-chain settlement is wired when `RPC_URL`/`ESCROW_ADDR`/
//! `ORACLE_KEY` are set, else it logs.

mod auth;
mod matchmaking;
mod room;
mod ws;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use ledger::{Address, SettlementSink, U256};
use persistence::{Db, Tc as PgTc, Wager as PgWager};
use protocol::{Color, GameId, TimeControl};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use tower_http::cors::CorsLayer;
use uuid::Uuid;

use crate::matchmaking::Lobby;
use crate::room::{spawn_room, RoomHandle, StakeInfo};

#[derive(Clone)]
pub struct AppState(pub Arc<Inner>);

pub struct Inner {
    pub rooms: Mutex<HashMap<GameId, RoomHandle>>,
    /// launch token -> (game, color)
    pub tokens: Mutex<HashMap<String, (GameId, Color)>>,
    pub settlement: Arc<dyn SettlementSink>,
    pub db: Option<Arc<Db>>,
    pub lobby: Lobby,
    pub auth: auth::Auth,
}

/// On-chain seats + stake for a wagered game.
#[derive(Clone, Copy)]
pub struct WagerSeats {
    pub white: Address,
    pub black: Address,
    pub stake: U256,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    // Optional durable persistence.
    let db = match std::env::var("DATABASE_URL") {
        Ok(url) => {
            let db = Db::connect(&url).await?;
            db.migrate().await?;
            tracing::info!("persistence: connected to Postgres");
            Some(Arc::new(db))
        }
        Err(_) => {
            tracing::info!("persistence: DATABASE_URL unset, running in-memory");
            None
        }
    };

    let state = AppState(Arc::new(Inner {
        rooms: Mutex::new(HashMap::new()),
        tokens: Mutex::new(HashMap::new()),
        settlement: ledger::from_env(),
        db,
        lobby: Lobby::default(),
        auth: auth::Auth::default(),
    }));

    // Drain the settlement outbox on-chain in the background (durable path).
    if let Some(db) = state.0.db.clone() {
        let settlement = state.0.settlement.clone();
        tokio::spawn(settlement_worker(db, settlement));
    }

    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/games", post(create_game))
        .merge(auth::routes())
        .merge(matchmaking::routes())
        .route("/ws/game/{game_id}", get(ws::ws_handler))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let addr = std::env::var("BIND").unwrap_or_else(|_| "127.0.0.1:8080".to_string());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("chess-server listening on http://{addr}");
    axum::serve(listener, app).await?;
    Ok(())
}

/// Background worker: claims pending settlements and submits them on-chain.
/// At-least-once is safe — the escrow contract is replay-guarded.
async fn settlement_worker(db: Arc<Db>, settlement: Arc<dyn SettlementSink>) {
    use tokio::time::{interval, Duration};
    let mut tick = interval(Duration::from_secs(1));
    loop {
        tick.tick().await;
        let rows = match db.claim_settlements(8).await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("outbox claim failed: {e:#}");
                continue;
            }
        };
        for row in rows {
            let winner = match &row.winner_addr {
                None => None,
                Some(a) => match a.parse::<Address>() {
                    Ok(addr) => Some(addr),
                    Err(_) => {
                        let _ = db.complete_settlement(row.id, "failed", Some("bad winner addr")).await;
                        let _ = db.set_settlement_status(row.game_id, "failed").await;
                        continue;
                    }
                },
            };
            match settlement.report_result(row.game_id, winner).await {
                Ok(()) => {
                    let _ = db.complete_settlement(row.id, "settled", None).await;
                    let _ = db.set_settlement_status(row.game_id, "settled").await;
                    tracing::info!(game_id = %row.game_id, "outbox: settled on-chain");
                }
                Err(e) => {
                    let msg = e.to_string();
                    let _ = db.complete_settlement(row.id, "failed", Some(&msg)).await;
                    let _ = db.set_settlement_status(row.game_id, "failed").await;
                    tracing::error!(game_id = %row.game_id, "outbox: settle failed: {msg}");
                }
            }
        }
    }
}

#[derive(Deserialize)]
struct CreateGameReq {
    #[serde(default = "default_initial")]
    initial_secs: u64,
    #[serde(default = "default_increment")]
    increment_secs: u64,
    white_addr: Option<String>,
    black_addr: Option<String>,
    stake: Option<String>,
}
fn default_initial() -> u64 {
    60
}
fn default_increment() -> u64 {
    1
}

#[derive(Serialize)]
pub struct CreateGameResp {
    pub game_id: GameId,
    pub white_token: String,
    pub black_token: String,
    pub spectate_path: String,
}

async fn create_game(
    State(state): State<AppState>,
    Json(req): Json<CreateGameReq>,
) -> Json<CreateGameResp> {
    let tc = TimeControl {
        initial_ms: req.initial_secs * 1_000,
        increment_ms: req.increment_secs * 1_000,
    };
    let wager = parse_wager(&req.white_addr, &req.black_addr, &req.stake);
    let resp = state.start_game(tc, "casual", wager).await;
    Json(resp)
}

/// Parse optional on-chain seats into a `WagerSeats`.
pub fn parse_wager(
    white_addr: &Option<String>,
    black_addr: &Option<String>,
    stake: &Option<String>,
) -> Option<WagerSeats> {
    let white = white_addr.as_ref()?.parse::<Address>().ok()?;
    let black = black_addr.as_ref()?.parse::<Address>().ok()?;
    let stake = stake.as_ref()?.parse::<U256>().ok()?;
    Some(WagerSeats { white, black, stake })
}

impl AppState {
    /// Create a game (optionally wagered), spawn its room, persist it, open
    /// escrow if wagered, and register launch tokens. Shared by /games, park
    /// accept, and the matchmaking queue.
    pub async fn start_game(
        &self,
        tc: TimeControl,
        mode: &str,
        wager: Option<WagerSeats>,
    ) -> CreateGameResp {
        let game_id = Uuid::new_v4();
        let stake_info = wager.map(|w| StakeInfo {
            white: w.white,
            black: w.black,
        });

        // Persist the game row.
        if let Some(db) = &self.0.db {
            let pwager = wager.map(|w| PgWager {
                white_addr: w.white.to_string(),
                black_addr: w.black.to_string(),
                stake: Decimal::from(w.stake.to::<u128>()),
            });
            let (ww, bw) = match &pwager {
                Some(w) => (Some(w.white_addr.as_str()), Some(w.black_addr.as_str())),
                None => (None, None),
            };
            if let Err(e) = db
                .create_game(
                    game_id,
                    mode,
                    ww,
                    bw,
                    PgTc {
                        initial_ms: tc.initial_ms as i64,
                        increment_ms: tc.increment_ms as i64,
                    },
                    pwager.as_ref(),
                )
                .await
            {
                tracing::error!(%game_id, "persist create_game failed: {e:#}");
            }
        }

        // Lock stakes on-chain.
        if let Some(w) = wager {
            if let Err(e) = self
                .0
                .settlement
                .open_escrow(game_id, w.white, w.black, w.stake)
                .await
            {
                tracing::error!(%game_id, "open_escrow failed: {e:#}");
            }
        }

        let handle = spawn_room(
            game_id,
            tc,
            self.0.settlement.clone(),
            stake_info,
            self.0.db.clone(),
        );
        self.0.rooms.lock().unwrap().insert(game_id, handle);

        let white_token = Uuid::new_v4().simple().to_string();
        let black_token = Uuid::new_v4().simple().to_string();
        {
            let mut tokens = self.0.tokens.lock().unwrap();
            tokens.insert(white_token.clone(), (game_id, Color::White));
            tokens.insert(black_token.clone(), (game_id, Color::Black));
        }

        tracing::info!(%game_id, mode, wagered = wager.is_some(), "game created");
        CreateGameResp {
            game_id,
            white_token,
            black_token,
            spectate_path: format!("/ws/game/{game_id}"),
        }
    }

    /// Resolve a launch token to its (game, color) seat.
    pub fn token_seat(&self, token: &str) -> Option<(GameId, Color)> {
        self.0.tokens.lock().unwrap().get(token).copied()
    }

    /// Clone a room's command sender + subscribe to its spectator stream.
    pub fn room_channels(
        &self,
        game_id: &GameId,
    ) -> Option<(
        tokio::sync::mpsc::Sender<room::RoomCmd>,
        tokio::sync::broadcast::Receiver<protocol::ServerMessage>,
    )> {
        let rooms = self.0.rooms.lock().unwrap();
        let handle = rooms.get(game_id)?;
        Some((handle.cmd_tx.clone(), handle.spectate_tx.subscribe()))
    }
}
