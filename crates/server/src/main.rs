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
mod players;
mod room;
mod ws;

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use ledger::{Address, SettlementSink, U256};
use persistence::{Db, Tc as PgTc, Wager as PgWager};
use protocol::{Color, GameId, TimeControl};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tower_http::cors::CorsLayer;
use uuid::Uuid;

use crate::matchmaking::Lobby;
use crate::room::{spawn_room, RoomHandle, StakeInfo};

/// Input bounds (reject absurd / overflow-inducing values).
pub const MAX_INITIAL_SECS: u64 = 3 * 60 * 60; // 3 hours
pub const MAX_INCREMENT_SECS: u64 = 180;
/// Max stake in USDC base units (6 dp) — 1,000,000 USDC. Bounds the U256→u128
/// conversion and absurd wagers.
pub const MAX_STAKE: u128 = 1_000_000_000_000;

#[derive(Clone)]
pub struct AppState(pub Arc<Inner>);

pub struct Inner {
    pub rooms: Mutex<HashMap<GameId, RoomHandle>>,
    /// Public metadata for in-progress games, so the lobby can list games to
    /// spectate. Populated at start, evicted with the room on finish.
    pub live_games: Mutex<HashMap<GameId, LiveGame>>,
    /// launch token -> (game, color). Removed when the game ends.
    pub tokens: Mutex<HashMap<String, (GameId, Color)>>,
    pub settlement: Arc<dyn SettlementSink>,
    pub db: Option<Arc<Db>>,
    pub lobby: Lobby,
    pub auth: auth::Auth,
    /// Rooms signal their game id here on finish so we can evict state.
    pub cleanup_tx: mpsc::Sender<GameId>,
    /// Rooms report game outcomes here for mode standings.
    pub results_tx: mpsc::Sender<GameOutcome>,
}

/// On-chain seats + stake for a wagered game.
#[derive(Clone, Copy)]
pub struct WagerSeats {
    pub white: Address,
    pub black: Address,
    pub stake: U256,
}

/// Reported by a room when its game ends, so modes can update standings.
#[derive(Clone, Copy)]
pub struct GameOutcome {
    pub game_id: GameId,
    pub winner: Option<Color>,
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

    let (cleanup_tx, cleanup_rx) = mpsc::channel::<GameId>(256);
    let (results_tx, results_rx) = mpsc::channel::<GameOutcome>(256);

    let state = AppState(Arc::new(Inner {
        rooms: Mutex::new(HashMap::new()),
        live_games: Mutex::new(HashMap::new()),
        tokens: Mutex::new(HashMap::new()),
        settlement: ledger::from_env(),
        db,
        lobby: Lobby::default(),
        auth: auth::Auth::default(),
        cleanup_tx,
        results_tx,
    }));

    // Production profile: refuse to start half-configured, so a misconfigured
    // node fails loudly at boot instead of silently rejecting every wager.
    if env_flag("REQUIRE_ONCHAIN") {
        let mut problems = Vec::new();
        if state.0.db.is_none() {
            problems.push("DATABASE_URL unset");
        }
        if !state.0.settlement.is_onchain() {
            problems.push("on-chain settlement not configured (RPC_URL/ESCROW_ADDR/ORACLE_KEY)");
        }
        if std::env::var("SIWE_DOMAIN").is_err() {
            problems.push("SIWE_DOMAIN unset");
        }
        if std::env::var("WEB_ORIGIN").is_err() {
            problems.push("WEB_ORIGIN unset");
        }
        if !problems.is_empty() {
            anyhow::bail!("REQUIRE_ONCHAIN set but misconfigured: {}", problems.join("; "));
        }
        tracing::info!("production profile OK (db + on-chain settlement + SIWE_DOMAIN + WEB_ORIGIN)");
    }

    // Drain the per-game + tournament settlement outboxes on-chain (durable).
    // Supervised: restarted if they ever exit/panic so settlement never stops.
    if let Some(db) = state.0.db.clone() {
        let s = state.0.settlement.clone();
        {
            let (db, s) = (db.clone(), s.clone());
            supervise("settlement", move || settlement_worker(db.clone(), s.clone()));
        }
        {
            let (db, s) = (db.clone(), s.clone());
            supervise("tournament-settlement", move || {
                tournament_settlement_worker(db.clone(), s.clone())
            });
        }
    }
    // Evict finished games' rooms + tokens; periodically sweep stale lobby state.
    tokio::spawn(cleanup_task(state.clone(), cleanup_rx));
    {
        let st = state.clone();
        supervise("sweep", move || sweep_task(st.clone()));
    }
    // Update mode standings (gauntlet/tournament) as games finish.
    tokio::spawn(matchmaking::results_task(state.clone(), results_rx));
    // Recover tournaments interrupted by a restart: settle completed ones by
    // result, mark interrupted ones abandoned (entrants refund on-chain).
    matchmaking::recover_tournaments(&state).await;

    // Restrict CORS to the configured web origin (no permissive on a money API).
    // A malformed WEB_ORIGIN logs and falls back rather than panicking at boot.
    let web_origin = std::env::var("WEB_ORIGIN").unwrap_or_else(|_| "http://localhost:3000".into());
    let origin_val = web_origin
        .parse::<axum::http::HeaderValue>()
        .unwrap_or_else(|_| {
            tracing::warn!("invalid WEB_ORIGIN '{web_origin}', falling back to http://localhost:3000");
            "http://localhost:3000".parse().unwrap()
        });
    let cors = CorsLayer::new()
        .allow_origin(origin_val)
        .allow_methods(tower_http::cors::Any)
        .allow_headers(tower_http::cors::Any);

    let app = Router::new()
        // Friendly root so the API doesn't 404 (Fly's post-deploy smoke test
        // curls `/`). This server is an API + WebSocket hub; the UI is elsewhere.
        .route(
            "/",
            get(|| async { "OpenChess game server — API + WebSocket hub. Play at https://openchess.ai" }),
        )
        .route("/health", get(|| async { "ok" }))
        .route("/ready", get(ready))
        .route("/oracle", get(oracle_info))
        .route("/config", get(config_info))
        .route("/games", post(create_game))
        .route("/games/live", get(live_games))
        .merge(auth::routes())
        .merge(matchmaking::routes())
        .merge(players::routes())
        .route("/ws/game/{game_id}", get(ws::ws_handler))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .layer(cors)
        .with_state(state);

    let addr = std::env::var("BIND").unwrap_or_else(|_| "127.0.0.1:8080".to_string());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("chess-server listening on http://{addr}");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

fn env_flag(key: &str) -> bool {
    matches!(std::env::var(key).ok().as_deref(), Some("1") | Some("true") | Some("TRUE"))
}

/// Spawn a long-lived worker and restart it if it ever exits or panics, so a
/// transient failure can't permanently stop settlement/sweeps.
fn supervise<F, Fut>(name: &'static str, make: F)
where
    F: Fn() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    tokio::spawn(async move {
        loop {
            match tokio::spawn(make()).await {
                Ok(()) => tracing::error!("worker {name} exited; restarting in 1s"),
                Err(e) => tracing::error!("worker {name} panicked ({e}); restarting in 1s"),
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    });
}

/// Readiness: distinct from liveness `/health` — checks the DB is reachable so a
/// node that lost Postgres is pulled from the load balancer.
async fn ready(State(state): State<AppState>) -> Result<&'static str, StatusCode> {
    if let Some(db) = &state.0.db {
        if db.ping().await.is_err() {
            return Err(StatusCode::SERVICE_UNAVAILABLE);
        }
    }
    Ok("ready")
}

#[derive(Serialize)]
struct OracleInfo {
    /// Address that signs game results (`server_sig`), so clients can verify them.
    address: Option<String>,
}

/// Publishes the oracle/result-signer address for client-side result verification.
async fn oracle_info(State(state): State<AppState>) -> Json<OracleInfo> {
    Json(OracleInfo {
        address: state.0.settlement.signer_address(),
    })
}

#[derive(Serialize)]
struct ConfigInfo {
    /// Escrow contract address (None ⇒ wagering disabled on this server).
    escrow: Option<String>,
    /// Chain the SIWE messages + escrow live on (matches `SIWE_CHAIN_ID`).
    chain_id: u64,
    /// Whether wagered play is available (on-chain settlement is configured).
    wager_enabled: bool,
}

/// Public snapshot of an in-progress game, for the spectate lobby.
#[derive(Clone, Serialize)]
pub struct LiveGame {
    pub game_id: GameId,
    pub mode: String,
    /// Wallets for a wagered game; `None` for casual/engine-vs-engine games.
    pub white: Option<String>,
    pub black: Option<String>,
    pub stake: Option<String>,
    pub initial_secs: u64,
    pub increment_secs: u64,
    pub created_ms: u64,
}

/// List in-progress games so the lobby can offer them to spectate.
async fn live_games(State(state): State<AppState>) -> Json<Vec<LiveGame>> {
    let mut list: Vec<LiveGame> = state.0.live_games.lock().values().cloned().collect();
    // Newest first.
    list.sort_by(|a, b| b.created_ms.cmp(&a.created_ms));
    Json(list)
}

/// Publishes the on-chain config the web app needs to wire deposits/wagers:
/// the escrow address and expected chain — single-sourced from the server.
async fn config_info(State(state): State<AppState>) -> Json<ConfigInfo> {
    let chain_id = std::env::var("SIWE_CHAIN_ID")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8453);
    Json(ConfigInfo {
        escrow: state.0.settlement.escrow_address(),
        chain_id,
        wager_enabled: state.0.settlement.is_onchain(),
    })
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        // SIGTERM is what Kubernetes/systemd send on stop.
        if let Ok(mut s) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
    tracing::info!("shutdown signal received");
}

/// Remove a finished game's room handle and its launch tokens.
async fn cleanup_task(state: AppState, mut rx: mpsc::Receiver<GameId>) {
    while let Some(game_id) = rx.recv().await {
        state.0.rooms.lock().remove(&game_id);
        state.0.live_games.lock().remove(&game_id);
        state
            .0
            .tokens
            .lock()
            .retain(|_, (g, _)| *g != game_id);
        tracing::debug!(%game_id, "evicted finished game state");
    }
}

/// Periodically expire stale lobby/auth state (bounds memory; mitigates DoS).
async fn sweep_task(state: AppState) {
    use tokio::time::{interval, Duration};
    let mut tick = interval(Duration::from_secs(60));
    loop {
        tick.tick().await;
        state.0.auth.sweep_expired();
        state.0.lobby.sweep_expired();
        // Prune game->mode routing entries for games that no longer exist.
        let live: std::collections::HashSet<GameId> =
            state.0.rooms.lock().keys().copied().collect();
        state.0.lobby.prune_games(&live);
    }
}

/// Background worker: claims pending settlements and submits them on-chain.
/// Transient failures are requeued with an attempt cap; crashed-worker rows are
/// reaped back to pending; an already-settled game (crash-after-submit / replay
/// revert) is treated as success.
async fn settlement_worker(db: Arc<Db>, settlement: Arc<dyn SettlementSink>) {
    use tokio::time::{interval, Duration};
    let mut tick = interval(Duration::from_secs(1));
    loop {
        tick.tick().await;

        // Reap rows stranded in `processing` by a crashed worker. The lease must
        // exceed worst-case on-chain confirmation so we don't requeue an
        // in-flight submit.
        if let Err(e) = db.requeue_stale(300).await {
            tracing::warn!("outbox reaper failed: {e:#}");
        }

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
                        // Permanently malformed — never retryable.
                        let _ = db
                            .finalize_settlement(row.id, row.game_id, "failed", Some("bad winner addr"))
                            .await;
                        continue;
                    }
                },
            };
            match settlement.report_result(row.game_id, winner).await {
                Ok(()) => {
                    let _ = db.finalize_settlement(row.id, row.game_id, "settled", None).await;
                    tracing::info!(game_id = %row.game_id, "outbox: settled on-chain");
                }
                Err(e) => {
                    let msg = e.to_string();
                    // The submit may have actually landed (crash/replay): if the
                    // chain says it's settled, that's success, not failure.
                    if settlement.is_settled(row.game_id).await {
                        let _ = db.finalize_settlement(row.id, row.game_id, "settled", None).await;
                        tracing::info!(game_id = %row.game_id, "outbox: already settled on-chain");
                    } else if row.attempts >= persistence::MAX_SETTLE_ATTEMPTS {
                        let _ = db.finalize_settlement(row.id, row.game_id, "failed", Some(&msg)).await;
                        tracing::error!(game_id = %row.game_id, attempts = row.attempts, "outbox: giving up: {msg}");
                    } else {
                        // Transient: requeue for retry on a later tick.
                        let _ = db.requeue_settlement(row.id, Some(&msg)).await;
                        tracing::warn!(game_id = %row.game_id, attempts = row.attempts, "outbox: transient, will retry: {msg}");
                    }
                }
            }
        }
    }
}

/// Durable tournament settlement worker (parallels `settlement_worker`).
async fn tournament_settlement_worker(db: Arc<Db>, settlement: Arc<dyn SettlementSink>) {
    use tokio::time::{interval, Duration};
    let mut tick = interval(Duration::from_secs(1));
    loop {
        tick.tick().await;
        if let Err(e) = db.requeue_stale_tournaments(300).await {
            tracing::warn!("tournament outbox reaper failed: {e:#}");
        }
        let rows = match db.claim_tournament_settlements(8).await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("tournament outbox claim failed: {e:#}");
                continue;
            }
        };
        for row in rows {
            match settle_tournament_row(&settlement, &row).await {
                Ok(()) => {
                    let _ = db.set_tournament_settlement_status(row.id, "settled", None).await;
                    tracing::info!(tid = %row.tid, "tournament outbox: settled on-chain");
                }
                Err(e) => {
                    let msg = e.to_string();
                    if settlement.is_tournament_settled(row.tid).await {
                        let _ = db.set_tournament_settlement_status(row.id, "settled", None).await;
                    } else if row.attempts >= persistence::MAX_SETTLE_ATTEMPTS {
                        let _ = db.set_tournament_settlement_status(row.id, "failed", Some(&msg)).await;
                        tracing::error!(tid = %row.tid, "tournament outbox: giving up: {msg}");
                    } else {
                        let _ = db.set_tournament_settlement_status(row.id, "pending", Some(&msg)).await;
                        tracing::warn!(tid = %row.tid, "tournament outbox: transient, will retry: {msg}");
                    }
                }
            }
        }
    }
}

async fn settle_tournament_row(
    settlement: &Arc<dyn SettlementSink>,
    row: &persistence::TournamentOutboxRow,
) -> anyhow::Result<()> {
    match row.mode.as_str() {
        "direct" => {
            let winners = json_addrs(&row.payload, "winners")?;
            let payouts = json_u256s(&row.payload, "payouts")?;
            settlement.settle_tournament(row.tid, winners, payouts).await
        }
        "root" => {
            let leaves = json_leaves(&row.payload)?;
            settlement.settle_tournament_root(row.tid, leaves).await.map(|_| ())
        }
        other => Err(anyhow::anyhow!("unknown tournament settle mode: {other}")),
    }
}

fn json_addrs(v: &serde_json::Value, key: &str) -> anyhow::Result<Vec<Address>> {
    v.get(key)
        .and_then(|a| a.as_array())
        .ok_or_else(|| anyhow::anyhow!("missing {key}"))?
        .iter()
        .map(|s| {
            s.as_str()
                .and_then(|s| s.parse::<Address>().ok())
                .ok_or_else(|| anyhow::anyhow!("bad address in {key}"))
        })
        .collect()
}

fn json_u256s(v: &serde_json::Value, key: &str) -> anyhow::Result<Vec<U256>> {
    v.get(key)
        .and_then(|a| a.as_array())
        .ok_or_else(|| anyhow::anyhow!("missing {key}"))?
        .iter()
        .map(|s| {
            s.as_str()
                .and_then(|s| s.parse::<U256>().ok())
                .ok_or_else(|| anyhow::anyhow!("bad amount in {key}"))
        })
        .collect()
}

fn json_leaves(v: &serde_json::Value) -> anyhow::Result<Vec<(Address, U256)>> {
    v.get("leaves")
        .and_then(|a| a.as_array())
        .ok_or_else(|| anyhow::anyhow!("missing leaves"))?
        .iter()
        .map(|pair| {
            let a = pair.get(0).and_then(|x| x.as_str()).and_then(|s| s.parse::<Address>().ok());
            let amt = pair.get(1).and_then(|x| x.as_str()).and_then(|s| s.parse::<U256>().ok());
            match (a, amt) {
                (Some(a), Some(amt)) => Ok((a, amt)),
                _ => Err(anyhow::anyhow!("bad leaf")),
            }
        })
        .collect()
}

#[derive(Deserialize)]
struct CreateGameReq {
    #[serde(default = "default_initial")]
    initial_secs: u64,
    #[serde(default = "default_increment")]
    increment_secs: u64,
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

/// `/games` creates an **unwagered (casual)** game with two open seats. Wagered
/// games go through the authenticated Park/Gauntlet matchmaking flows, where
/// each seat is bound to the wallet that consented to stake it.
async fn create_game(
    State(state): State<AppState>,
    Json(req): Json<CreateGameReq>,
) -> Result<Json<CreateGameResp>, StatusCode> {
    let tc = validate_tc(req.initial_secs, req.increment_secs)?;
    let resp = state.start_game(tc, "casual", None).await?;
    Ok(Json(resp))
}

/// Validate + build a time control, rejecting absurd / overflow-inducing values.
pub fn validate_tc(initial_secs: u64, increment_secs: u64) -> Result<TimeControl, StatusCode> {
    if initial_secs == 0 || initial_secs > MAX_INITIAL_SECS || increment_secs > MAX_INCREMENT_SECS {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(TimeControl {
        initial_ms: initial_secs * 1_000,
        increment_ms: increment_secs * 1_000,
    })
}

/// Build wager seats from authenticated wallet strings + a stake string.
/// Rejects identical seats and out-of-range stakes.
pub fn build_wager(white: &str, black: &str, stake: &str) -> Result<WagerSeats, StatusCode> {
    let white = white.parse::<Address>().map_err(|_| StatusCode::BAD_REQUEST)?;
    let black = black.parse::<Address>().map_err(|_| StatusCode::BAD_REQUEST)?;
    let stake = stake.parse::<U256>().map_err(|_| StatusCode::BAD_REQUEST)?;
    if white == black {
        return Err(StatusCode::BAD_REQUEST);
    }
    if stake == U256::ZERO || stake > U256::from(MAX_STAKE) {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(WagerSeats { white, black, stake })
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
    ) -> Result<CreateGameResp, StatusCode> {
        let game_id = Uuid::new_v4();
        let stake_info = wager.map(|w| StakeInfo {
            white: w.white,
            black: w.black,
        });

        // Fail-closed: never accept a wager we cannot settle on-chain, or with
        // identical / overflowing seats.
        if let Some(w) = wager {
            if !self.0.settlement.is_onchain() {
                tracing::warn!(%game_id, "refusing wagered game: no on-chain settlement configured");
                return Err(StatusCode::SERVICE_UNAVAILABLE);
            }
            if w.white == w.black || w.stake == U256::ZERO || w.stake > U256::from(MAX_STAKE) {
                return Err(StatusCode::BAD_REQUEST);
            }
        }

        // Persist the game row. For a wagered game this must succeed (fail-closed).
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
                if wager.is_some() {
                    return Err(StatusCode::INTERNAL_SERVER_ERROR);
                }
            }
        }

        // Lock stakes on-chain BEFORE spawning the room. If this fails for a
        // wagered game, abort — never let an unbacked wagered game play.
        if let Some(w) = wager {
            if let Err(e) = self
                .0
                .settlement
                .open_escrow(game_id, w.white, w.black, w.stake)
                .await
            {
                tracing::error!(%game_id, "open_escrow failed, aborting wagered game: {e:#}");
                if let Some(db) = &self.0.db {
                    let _ = db.abort_game(game_id, "escrow_open_failed").await;
                }
                return Err(StatusCode::BAD_GATEWAY);
            }
        }

        let handle = spawn_room(
            game_id,
            tc,
            self.0.settlement.clone(),
            stake_info,
            self.0.db.clone(),
            self.0.cleanup_tx.clone(),
            self.0.results_tx.clone(),
        );
        self.0.rooms.lock().insert(game_id, handle);
        self.0.live_games.lock().insert(
            game_id,
            LiveGame {
                game_id,
                mode: mode.to_string(),
                white: wager.map(|w| w.white.to_string()),
                black: wager.map(|w| w.black.to_string()),
                stake: wager.map(|w| w.stake.to_string()),
                initial_secs: tc.initial_ms / 1000,
                increment_secs: tc.increment_ms / 1000,
                created_ms: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
            },
        );

        let white_token = Uuid::new_v4().simple().to_string();
        let black_token = Uuid::new_v4().simple().to_string();
        {
            let mut tokens = self.0.tokens.lock();
            tokens.insert(white_token.clone(), (game_id, Color::White));
            tokens.insert(black_token.clone(), (game_id, Color::Black));
        }

        tracing::info!(%game_id, mode, wagered = wager.is_some(), "game created");
        Ok(CreateGameResp {
            game_id,
            white_token,
            black_token,
            spectate_path: format!("/ws/game/{game_id}"),
        })
    }

    /// Resolve a launch token to its (game, color) seat.
    pub fn token_seat(&self, token: &str) -> Option<(GameId, Color)> {
        self.0.tokens.lock().get(token).copied()
    }

    /// The authenticated wallet for a request, from its `Authorization: Bearer`.
    pub fn authed_wallet(&self, headers: &HeaderMap) -> Option<String> {
        let token = headers
            .get("authorization")?
            .to_str()
            .ok()?
            .strip_prefix("Bearer ")?;
        self.0.auth.wallet_for_token(token)
    }

    /// Clone a room's command sender + subscribe to its spectator stream.
    pub fn room_channels(
        &self,
        game_id: &GameId,
    ) -> Option<(
        tokio::sync::mpsc::Sender<room::RoomCmd>,
        tokio::sync::broadcast::Receiver<protocol::ServerMessage>,
    )> {
        let rooms = self.0.rooms.lock();
        let handle = rooms.get(game_id)?;
        Some((handle.cmd_tx.clone(), handle.spectate_tx.subscribe()))
    }
}
