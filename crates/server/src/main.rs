//! Chess game server: HTTP for game creation + matchmaking (Park/Patzer,
//! Gauntlet queue, Tournament) and a WebSocket hub connecting bring-your-own-
//! engine player clients and spectators to per-game room actors.
//!
//! Durable state (games, moves, results) is persisted to Postgres when
//! `DATABASE_URL` is set; lobby/matchmaking state is in-memory (the Redis layer
//! in production). On-chain settlement is wired when `RPC_URL`/`ESCROW_ADDR`/
//! `ORACLE_KEY` are set, else it logs.

mod admin;
mod agents;
mod alert;
mod auth;
mod matchmaking;
mod players;
mod ratelimit;
mod room;
mod ws;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
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
/// Max stake in USDC base units (6 dp). Deliberately small — **25 USDC** — for
/// the unaudited mainnet launch, so the blast radius is capped while the oracle
/// is a single hot key and the contract hasn't had an independent audit. Raise
/// it once those are addressed. Also bounds the U256→u128 conversion.
pub const MAX_STAKE: u128 = 25_000_000;

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
    /// Owner-toggled maintenance/drain switch. When `true`, no new game starts
    /// (existing games play out). Authoritative check lives in `start_game`;
    /// persisted to `server_settings` so it survives restarts.
    pub maintenance: AtomicBool,
    /// The escrow owner wallet (lowercased) allowed to toggle maintenance.
    /// Seeded on boot from `ADMIN_WALLET` or the contract `owner()`; if that
    /// boot lookup failed (`None`) it is resolved lazily on first admin use, so
    /// a transient boot-time RPC error can't lock the owner out for the whole
    /// process. `None` after a lazy attempt ⇒ admin disabled (fail-closed).
    pub admin_wallet: Mutex<Option<String>>,
    pub lobby: Lobby,
    pub auth: auth::Auth,
    /// Connected user-run engines (bots), keyed by owner wallet.
    pub agents: agents::Agents,
    /// Per-IP / per-owner rate limits + WS connection caps (abuse guardrails
    /// for a money-adjacent API). Single-node, like the rest of the live state.
    pub limits: ratelimit::RateLimits,
    /// Rooms signal their game id here on finish so we can evict state.
    pub cleanup_tx: mpsc::Sender<GameId>,
    /// Rooms report game outcomes here for mode standings.
    pub results_tx: mpsc::Sender<GameOutcome>,
}

/// Self-declared identity for one seat: a display name and the engine the
/// player claims to run. Informational only — never used for auth or money.
#[derive(Clone, Default)]
pub struct SeatMeta {
    pub name: Option<String>,
    pub engine: Option<String>,
}

/// Clean a client-supplied display label: strip control characters, collapse
/// surrounding whitespace, and cap the length so the lobby can't be defaced.
pub fn sanitize_label(s: &str) -> Option<String> {
    let cleaned: String = s
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .chars()
        .take(48)
        .collect();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

/// Shorten a wallet address for display: `0x1234…abcd`. Operates on chars, not
/// bytes — inputs can be arbitrary user-supplied strings (tournament names).
pub fn short_addr(a: &str) -> String {
    let chars: Vec<char> = a.chars().collect();
    if chars.len() > 12 {
        let head: String = chars[..6].iter().collect();
        let tail: String = chars[chars.len() - 4..].iter().collect();
        format!("{head}…{tail}")
    } else {
        a.to_string()
    }
}

/// How a seat's launch credential is delivered when a game starts.
pub enum SeatDelivery {
    /// The token is returned to the HTTP caller (browser/native polls it).
    Browser,
    /// The seat is pushed to the owner's connected agent; the token never
    /// leaves the server. `wallet` lets the registry tie the game to the
    /// agent so its busy flag is cleared when the room dies.
    Agent {
        wallet: String,
        tx: mpsc::Sender<protocol::ServerToAgent>,
        uci_options: Vec<(String, String)>,
    },
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
    /// Total half-moves played. Lets a mode tell a contested loss from a
    /// no-move forfeit (e.g. gauntlet auto-stop on a dead engine).
    pub plies: u32,
    /// Whether each seat ever readied (its engine came alive). Only meaningful
    /// for a never-started reap (`plies == 0`): lets a mode stop a session whose
    /// OWN seat no-showed without punishing an opponent that did show up.
    pub white_showed_up: bool,
    pub black_showed_up: bool,
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

    let settlement = ledger::from_env();
    // Who may toggle maintenance: ADMIN_WALLET override, else the on-chain
    // escrow owner (read live so it tracks ownership transfers).
    let admin_wallet = resolve_admin_wallet(&*settlement).await;
    // Restore the durable maintenance flag. A read failure defaults OFF but is
    // logged loudly — silently dropping a persisted pause would resume wagered
    // games during the exact drain window it was set to protect.
    let maintenance = match &db {
        Some(db) => match db.get_setting(admin::MAINTENANCE_KEY).await {
            Ok(v) => v.as_deref() == Some("true"),
            Err(e) => {
                tracing::error!("failed to restore maintenance flag (defaulting OFF): {e:#}");
                false
            }
        },
        None => false,
    };
    if maintenance {
        tracing::warn!("restored maintenance mode = ON from server_settings");
    }

    let (cleanup_tx, cleanup_rx) = mpsc::channel::<GameId>(256);
    let (results_tx, results_rx) = mpsc::channel::<GameOutcome>(256);

    let state = AppState(Arc::new(Inner {
        rooms: Mutex::new(HashMap::new()),
        live_games: Mutex::new(HashMap::new()),
        tokens: Mutex::new(HashMap::new()),
        settlement,
        db,
        maintenance: AtomicBool::new(maintenance),
        admin_wallet: Mutex::new(admin_wallet),
        lobby: Lobby::default(),
        auth: auth::Auth::default(),
        agents: agents::Agents::default(),
        limits: ratelimit::RateLimits::from_env(),
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
            anyhow::bail!(
                "REQUIRE_ONCHAIN set but misconfigured: {}",
                problems.join("; ")
            );
        }
        tracing::info!(
            "production profile OK (db + on-chain settlement + SIWE_DOMAIN + WEB_ORIGIN)"
        );
    }

    // Drain the per-game + tournament settlement outboxes on-chain (durable).
    // Supervised: restarted if they ever exit/panic so settlement never stops.
    if let Some(db) = state.0.db.clone() {
        let s = state.0.settlement.clone();
        {
            let (db, s) = (db.clone(), s.clone());
            supervise("settlement", move || {
                settlement_worker(db.clone(), s.clone())
            });
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
            tracing::warn!(
                "invalid WEB_ORIGIN '{web_origin}', falling back to http://localhost:3000"
            );
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
            get(|| async {
                "OpenChess game server — API + WebSocket hub. Play at https://openchess.ai"
            }),
        )
        .route("/health", get(|| async { "ok" }))
        .route("/ready", get(ready))
        .route("/oracle", get(oracle_info))
        .route("/config", get(config_info))
        .route("/games", post(create_game))
        .route("/games/live", get(live_games))
        // Throttle the auth routes per-IP: SIWE verify does signature recovery
        // and nonce/link mint credentials, so they're the cheapest thing to
        // abuse. (Applied only to these routes via route_layer.)
        .merge(auth::routes().route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            rate_limit_auth,
        )))
        .merge(admin::routes())
        .merge(matchmaking::routes())
        // Throttle the public read routes per-IP: cheap per hit, but the
        // leaderboard query is heavy, so cap how fast one IP can trigger it.
        .merge(players::routes().route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            rate_limit_reads,
        )))
        .merge(agents::routes())
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

/// Resolve the wallet allowed to administer the server (toggle maintenance):
/// `ADMIN_WALLET` if set and valid, else the escrow contract owner read live
/// from chain. Returns a lowercased `0x…` address, or `None` (admin disabled,
/// fail-closed) when neither is available.
async fn resolve_admin_wallet(settlement: &dyn SettlementSink) -> Option<String> {
    if let Ok(raw) = std::env::var("ADMIN_WALLET") {
        match raw.trim().parse::<Address>() {
            Ok(a) => {
                let a = format!("{a:?}").to_lowercase();
                tracing::info!(admin = %a, "admin wallet from ADMIN_WALLET");
                return Some(a);
            }
            Err(_) => tracing::warn!("ADMIN_WALLET is not a valid address; ignoring"),
        }
    }
    match settlement.owner().await {
        Some(owner) => {
            let a = format!("{owner:?}").to_lowercase();
            tracing::info!(admin = %a, "admin wallet from escrow owner()");
            Some(a)
        }
        None => {
            tracing::warn!(
                "no admin wallet resolved (ADMIN_WALLET unset, escrow owner() unavailable); \
                 maintenance toggle disabled"
            );
            None
        }
    }
}

fn env_flag(key: &str) -> bool {
    matches!(
        std::env::var(key).ok().as_deref(),
        Some("1") | Some("true") | Some("TRUE")
    )
}

/// Per-IP throttle middleware for the `/auth/*` routes (signature recovery +
/// credential minting).
async fn rate_limit_auth(
    State(state): State<AppState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    throttle(&state.0.limits.auth, req, next).await
}

/// Per-IP throttle middleware for the public read routes (`/players/*`,
/// `/leaderboard`) — bounds the rate an IP can trigger the heavy leaderboard
/// query.
async fn rate_limit_reads(
    State(state): State<AppState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    throttle(&state.0.limits.reads, req, next).await
}

/// Charge one token against `bucket` for the request's client IP, returning 429
/// (with `Retry-After`) when over budget. CORS preflight (`OPTIONS`) is not
/// counted — it carries no work and browsers send one per request.
async fn throttle(
    bucket: &ratelimit::TokenBucket,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    if req.method() == axum::http::Method::OPTIONS {
        return next.run(req).await;
    }
    let ip = ratelimit::client_ip(req.headers());
    if let Some(retry) = bucket.check(&ip) {
        return too_many(retry);
    }
    next.run(req).await
}

/// A `429 Too Many Requests` response carrying a `Retry-After` hint (seconds).
pub(crate) fn too_many(retry: std::time::Duration) -> axum::response::Response {
    use axum::response::IntoResponse;
    let mut resp = (StatusCode::TOO_MANY_REQUESTS, "rate limited\n").into_response();
    let secs = retry.as_secs().max(1).to_string();
    if let Ok(v) = axum::http::HeaderValue::from_str(&secs) {
        resp.headers_mut().insert("retry-after", v);
    }
    resp
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
    /// Domain SIWE messages must be bound to — native clients need it to build
    /// a message this server will accept.
    siwe_domain: String,
    /// Whether the server is in maintenance/drain mode: no new games start,
    /// existing ones play out. Clients show a banner + disable "create".
    maintenance: bool,
    /// The wallet allowed to toggle maintenance (the on-chain escrow owner).
    /// Public — it's readable on-chain — so the UI can show the admin control
    /// only to that wallet. `None` ⇒ admin actions disabled on this server.
    admin_wallet: Option<String>,
}

/// Public snapshot of an in-progress game, for the spectate lobby.
#[derive(Clone, Serialize)]
pub struct LiveGame {
    pub game_id: GameId,
    pub mode: String,
    /// Wallets for a wagered game; `None` for casual/engine-vs-engine games.
    pub white: Option<String>,
    pub black: Option<String>,
    /// Self-declared display names + engines (informational, sanitized).
    pub white_name: Option<String>,
    pub black_name: Option<String>,
    pub white_engine: Option<String>,
    pub black_engine: Option<String>,
    pub stake: Option<String>,
    pub initial_secs: u64,
    pub increment_secs: u64,
    pub created_ms: u64,
}

/// List in-progress games so the lobby can offer them to spectate. Only games
/// that have actually begun (both engines connected + ready) are listed — not
/// idle rooms still waiting for connections.
async fn live_games(State(state): State<AppState>) -> Json<Vec<LiveGame>> {
    let started: std::collections::HashSet<GameId> = {
        let rooms = state.0.rooms.lock();
        rooms
            .iter()
            .filter(|(_, h)| h.started.load(std::sync::atomic::Ordering::Relaxed))
            .map(|(id, _)| *id)
            .collect()
    };
    let mut list: Vec<LiveGame> = state
        .0
        .live_games
        .lock()
        .values()
        .filter(|g| started.contains(&g.game_id))
        .cloned()
        .collect();
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
        siwe_domain: auth::expected_domain(),
        maintenance: state.maintenance_on(),
        admin_wallet: state.0.admin_wallet.lock().clone(),
    })
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        // SIGTERM is what Kubernetes/systemd send on stop.
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
    tracing::info!("shutdown signal received");
}

/// Remove a finished game's room handle and its launch tokens, and free any
/// agents seated in it (the server owns the busy flag — a crashed or silent
/// client can't leave its bot claimed forever).
async fn cleanup_task(state: AppState, mut rx: mpsc::Receiver<GameId>) {
    while let Some(game_id) = rx.recv().await {
        state.0.rooms.lock().remove(&game_id);
        state.0.live_games.lock().remove(&game_id);
        state.0.tokens.lock().retain(|_, (g, _)| *g != game_id);
        state.0.agents.game_ended(game_id);
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
        state.0.limits.sweep();
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
                            .finalize_settlement(
                                row.id,
                                row.game_id,
                                "failed",
                                Some("bad winner addr"),
                            )
                            .await;
                        continue;
                    }
                },
            };
            match settlement.report_result(row.game_id, winner).await {
                Ok(()) => {
                    let _ = db
                        .finalize_settlement(row.id, row.game_id, "settled", None)
                        .await;
                    tracing::info!(game_id = %row.game_id, "outbox: settled on-chain");
                }
                Err(e) => {
                    let msg = e.to_string();
                    // The submit may have actually landed (crash/replay): if the
                    // chain says it's settled, that's success, not failure.
                    if settlement.is_settled(row.game_id).await {
                        let _ = db
                            .finalize_settlement(row.id, row.game_id, "settled", None)
                            .await;
                        tracing::info!(game_id = %row.game_id, "outbox: already settled on-chain");
                    } else if row.attempts >= persistence::MAX_SETTLE_ATTEMPTS {
                        let _ = db
                            .finalize_settlement(row.id, row.game_id, "failed", Some(&msg))
                            .await;
                        tracing::error!(game_id = %row.game_id, attempts = row.attempts, "outbox: giving up: {msg}");
                        alert::fire(format!(
                            "🚨 OpenChess: settlement outbox GAVE UP on game {} after {} attempts \
                             — the wager was not paid out on-chain. err: {msg}",
                            row.game_id, row.attempts
                        ));
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
                    let _ = db
                        .set_tournament_settlement_status(row.id, "settled", None)
                        .await;
                    tracing::info!(tid = %row.tid, "tournament outbox: settled on-chain");
                }
                Err(e) => {
                    let msg = e.to_string();
                    if settlement.is_tournament_settled(row.tid).await {
                        let _ = db
                            .set_tournament_settlement_status(row.id, "settled", None)
                            .await;
                    } else if row.attempts >= persistence::MAX_SETTLE_ATTEMPTS {
                        let _ = db
                            .set_tournament_settlement_status(row.id, "failed", Some(&msg))
                            .await;
                        tracing::error!(tid = %row.tid, "tournament outbox: giving up: {msg}");
                        alert::fire(format!(
                            "🚨 OpenChess: tournament settlement outbox GAVE UP on tournament {} \
                             after {} attempts — payouts were not made on-chain. err: {msg}",
                            row.tid, row.attempts
                        ));
                    } else {
                        let _ = db
                            .set_tournament_settlement_status(row.id, "pending", Some(&msg))
                            .await;
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
            settlement
                .settle_tournament(row.tid, winners, payouts)
                .await
        }
        "root" => {
            let leaves = json_leaves(&row.payload)?;
            settlement
                .settle_tournament_root(row.tid, leaves)
                .await
                .map(|_| ())
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
            let a = pair
                .get(0)
                .and_then(|x| x.as_str())
                .and_then(|s| s.parse::<Address>().ok());
            let amt = pair
                .get(1)
                .and_then(|x| x.as_str())
                .and_then(|s| s.parse::<U256>().ok());
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
    headers: HeaderMap,
    Json(req): Json<CreateGameReq>,
) -> Result<Json<CreateGameResp>, StatusCode> {
    // Unauthenticated + spawns a room actor on every call — throttle per-IP so a
    // flood can't exhaust tasks/memory on the single node.
    state.reject_if_rate_limited_create(&headers)?;
    let tc = validate_tc(req.initial_secs, req.increment_secs)?;
    let resp = state
        .start_game(
            tc,
            "casual",
            None,
            Default::default(),
            [SeatDelivery::Browser, SeatDelivery::Browser],
        )
        .await?;
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
    let white = white
        .parse::<Address>()
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    let black = black
        .parse::<Address>()
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    let stake = stake.parse::<U256>().map_err(|_| StatusCode::BAD_REQUEST)?;
    if white == black {
        return Err(StatusCode::BAD_REQUEST);
    }
    if stake == U256::ZERO || stake > U256::from(MAX_STAKE) {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(WagerSeats {
        white,
        black,
        stake,
    })
}

impl AppState {
    /// Create a game (optionally wagered), spawn its room, persist it, open
    /// escrow if wagered, register launch tokens, and deliver each seat
    /// (return the token, or push it to the owner's agent). Shared by /games,
    /// park accept, and the matchmaking queue — any mode can seat a bot by
    /// passing an Agent delivery.
    pub async fn start_game(
        &self,
        tc: TimeControl,
        mode: &str,
        wager: Option<WagerSeats>,
        meta: [SeatMeta; 2],         // [white, black] self-declared identity
        delivery: [SeatDelivery; 2], // [white, black] seat delivery
    ) -> Result<CreateGameResp, StatusCode> {
        // Maintenance/drain: the single chokepoint every mode funnels through,
        // so one guard blocks all new games while existing ones play out.
        self.reject_if_draining()?;

        // Global room ceiling: bound concurrent room actors so a creation flood
        // can't exhaust memory/tasks on the single node. Checked here (before any
        // escrow opens) so a rejected wagered game never locks funds on-chain.
        if self.0.rooms.lock().len() >= self.0.limits.max_rooms {
            tracing::warn!("refusing new game: room ceiling reached ({})", self.0.limits.max_rooms);
            return Err(StatusCode::SERVICE_UNAVAILABLE);
        }

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

        // Resolve each seat's display identity: declared name, else shortened
        // wallet (wagered games), else "anonymous".
        let seat_info = |m: &SeatMeta, wallet: Option<String>| protocol::OpponentInfo {
            name: m
                .name
                .clone()
                .or_else(|| wallet.map(|w| short_addr(&w)))
                .unwrap_or_else(|| "anonymous".into()),
            declared_engine: m.engine.clone(),
        };
        let players = [
            seat_info(&meta[0], wager.map(|w| w.white.to_string())),
            seat_info(&meta[1], wager.map(|w| w.black.to_string())),
        ];

        let handle = spawn_room(
            game_id,
            tc,
            self.0.settlement.clone(),
            stake_info,
            players,
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
                white_name: meta[0].name.clone(),
                black_name: meta[1].name.clone(),
                white_engine: meta[0].engine.clone(),
                black_engine: meta[1].engine.clone(),
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

        // Deliver bot seats to their agents. A failed push means the agent
        // vanished after being claimed — the game can never start, so abort it
        // NOW (refund escrow, evict state) rather than stranding locked stakes
        // behind the contract's 24h claimTimeout.
        let stake_str = wager.map(|w| w.stake.to_string());
        let seats = [
            (Color::White, &white_token, &delivery[0]),
            (Color::Black, &black_token, &delivery[1]),
        ];
        for (color, token, d) in seats {
            let SeatDelivery::Agent {
                wallet,
                tx,
                uci_options,
            } = d
            else {
                continue;
            };
            let sent = tx
                .send(protocol::ServerToAgent::AssignSeat {
                    game_id,
                    token: token.clone(),
                    color,
                    time_control: tc,
                    stake: stake_str.clone(),
                    uci_options: uci_options.clone(),
                })
                .await;
            if sent.is_err() {
                tracing::error!(%game_id, %wallet, ?color, "agent vanished before seat dispatch — aborting game");
                self.abort_started_game(game_id, wager).await;
                return Err(StatusCode::FAILED_DEPENDENCY);
            }
            // Tie the game to the agent so the registry can clear its busy
            // flag when the room dies, even if the client never reports idle.
            self.0.agents.bind_game(game_id, wallet);
        }

        tracing::info!(%game_id, mode, wagered = wager.is_some(), "game created");
        Ok(CreateGameResp {
            game_id,
            white_token,
            black_token,
            spectate_path: format!("/ws/game/{game_id}"),
        })
    }

    /// Roll back a game that was fully created (room spawned, escrow possibly
    /// locked) but can never be played. Refunds a wagered escrow by settling
    /// it as a draw; evicts room/tokens/live-game state.
    async fn abort_started_game(&self, game_id: GameId, wager: Option<WagerSeats>) {
        if wager.is_some() {
            // Draw settlement refunds both stakes. If this fails the funds are
            // still recoverable via the contract's claimTimeout — log loudly.
            if let Err(e) = self.0.settlement.report_result(game_id, None).await {
                tracing::error!(
                    %game_id,
                    "escrow refund after aborted dispatch FAILED (funds recoverable via claimTimeout): {e:#}"
                );
                alert::fire(format!(
                    "🚨 OpenChess: escrow refund FAILED for game {game_id} after an aborted \
                     dispatch — both stakes are locked until the contract's 24h claimTimeout. \
                     Investigate the oracle/RPC. err: {e:#}"
                ));
            }
        }
        if let Some(db) = &self.0.db {
            let _ = db.abort_game(game_id, "seat_dispatch_failed").await;
        }
        // Evict room handle, live-game entry, and launch tokens; the room task
        // itself exits via its never-started reap.
        let _ = self.0.cleanup_tx.send(game_id).await;
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

    /// Whether the server is in maintenance/drain mode (no new games).
    pub fn maintenance_on(&self) -> bool {
        self.0.maintenance.load(Ordering::Relaxed)
    }

    /// Reject a request while the server is draining. Call at the top of every
    /// game-creating or money-committing handler so the drain is enforced at
    /// each entry point (the authoritative check is also in `start_game`).
    pub fn reject_if_draining(&self) -> Result<(), StatusCode> {
        if self.maintenance_on() {
            Err(StatusCode::SERVICE_UNAVAILABLE)
        } else {
            Ok(())
        }
    }

    /// Per-IP throttle for the game/tournament **creation** routes. Each such
    /// call spawns a room actor and/or an oracle-gas-costing on-chain tx, so
    /// they must not be spammable. Call at the top of every creation handler
    /// (`create_game`, `queue_join`, `gauntlet_start`, `tourney_create/join/start`)
    /// — these live on the un-throttled matchmaking router (a shared route layer
    /// would also throttle the UI's polling GETs on the same paths).
    pub fn reject_if_rate_limited_create(&self, headers: &HeaderMap) -> Result<(), StatusCode> {
        let ip = ratelimit::client_ip(headers);
        if self.0.limits.create.check(&ip).is_some() {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        Ok(())
    }

    /// The wallet allowed to administer the server, resolving it lazily if the
    /// boot lookup failed — a transient boot-time RPC error must not lock the
    /// owner out for the whole process. Caches the result once resolved.
    async fn admin_wallet(&self) -> Option<String> {
        if let Some(w) = self.0.admin_wallet.lock().clone() {
            return Some(w);
        }
        // Boot lookup returned None (ADMIN_WALLET was unset too) — try once more
        // live against the contract.
        let owner = self.0.settlement.owner().await?;
        let w = format!("{owner:?}").to_lowercase();
        *self.0.admin_wallet.lock() = Some(w.clone());
        tracing::info!(admin = %w, "admin wallet resolved lazily from escrow owner()");
        Some(w)
    }

    /// Whether a request is from the escrow owner (the only admin). Requires a
    /// SIWE session whose wallet matches the admin wallet; if none can be
    /// resolved, nobody is admin (fail-closed). The (possibly RPC-backed) admin
    /// lookup only runs for an already-authenticated request.
    pub async fn is_admin(&self, headers: &HeaderMap) -> bool {
        let Some(w) = self.authed_wallet(headers) else {
            return false;
        };
        match self.admin_wallet().await {
            Some(owner) => w.eq_ignore_ascii_case(&owner),
            None => false,
        }
    }

    /// Flip maintenance mode. Persists FIRST so we never report success on a
    /// pause that wouldn't survive the restart it exists to protect: if the
    /// write fails, the in-memory flag is left unchanged and an error is
    /// returned. Returns the new state on success.
    pub async fn set_maintenance(&self, on: bool) -> Result<bool, StatusCode> {
        if let Some(db) = &self.0.db {
            if let Err(e) = db
                .set_setting(admin::MAINTENANCE_KEY, if on { "true" } else { "false" })
                .await
            {
                tracing::error!("failed to persist maintenance flag: {e:#}");
                return Err(StatusCode::INTERNAL_SERVER_ERROR);
            }
        }
        self.0.maintenance.store(on, Ordering::Relaxed);
        tracing::warn!(maintenance = on, "maintenance mode toggled");
        Ok(on)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_addr_is_char_safe_on_multibyte_input() {
        // A 42-BYTE string that passes byte-length guards but whose char
        // boundaries don't align with the old byte slicing (regression:
        // crafted casual-tournament names used to panic tourney_start).
        let evil = format!("0x{}a", "€".repeat(13));
        assert_eq!(evil.len(), 42);
        let s = short_addr(&evil);
        assert!(s.contains('…'));
        // Normal wallet addresses render as before.
        assert_eq!(
            short_addr("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"),
            "0xf39F…2266"
        );
        // Short strings pass through untouched.
        assert_eq!(short_addr("casual"), "casual");
    }

    #[test]
    fn sanitize_label_caps_by_chars() {
        assert_eq!(sanitize_label("  hi\u{0007} "), Some("hi".into()));
        assert!(sanitize_label(" \t").is_none());
        let long = "é".repeat(100);
        assert_eq!(sanitize_label(&long).unwrap().chars().count(), 48);
    }

    /// Minimal in-memory state (no DB, log-only settlement) for guard tests.
    fn test_state(maintenance: bool, admin_wallet: Option<&str>) -> AppState {
        let (cleanup_tx, _cleanup_rx) = mpsc::channel::<GameId>(8);
        let (results_tx, _results_rx) = mpsc::channel::<GameOutcome>(8);
        AppState(Arc::new(Inner {
            rooms: Mutex::new(HashMap::new()),
            live_games: Mutex::new(HashMap::new()),
            tokens: Mutex::new(HashMap::new()),
            settlement: Arc::new(ledger::LogSettlement),
            db: None,
            maintenance: AtomicBool::new(maintenance),
            admin_wallet: Mutex::new(admin_wallet.map(|w| w.to_lowercase())),
            lobby: Lobby::default(),
            auth: auth::Auth::default(),
            agents: agents::Agents::default(),
            limits: ratelimit::RateLimits::from_env(),
            cleanup_tx,
            results_tx,
        }))
    }

    fn bearer(token: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("authorization", format!("Bearer {token}").parse().unwrap());
        h
    }

    const TC: TimeControl = TimeControl {
        initial_ms: 60_000,
        increment_ms: 0,
    };

    #[tokio::test]
    async fn maintenance_blocks_new_games() {
        let state = test_state(true, None);
        let result = state
            .start_game(
                TC,
                "casual",
                None,
                Default::default(),
                [SeatDelivery::Browser, SeatDelivery::Browser],
            )
            .await;
        assert_eq!(result.err(), Some(StatusCode::SERVICE_UNAVAILABLE));
    }

    #[tokio::test]
    async fn casual_game_starts_when_not_in_maintenance() {
        // Positive control: the guard is what blocks, not some other precondition.
        let state = test_state(false, None);
        let resp = state
            .start_game(
                TC,
                "casual",
                None,
                Default::default(),
                [SeatDelivery::Browser, SeatDelivery::Browser],
            )
            .await
            .expect("casual game should start when not paused");
        assert!(!resp.white_token.is_empty());
    }

    #[tokio::test]
    async fn is_admin_requires_the_owner_session() {
        let owner = "0xAbC0000000000000000000000000000000000001";
        let state = test_state(false, Some(owner));
        // A session bound to the owner wallet → admin.
        let owner_token = state.0.auth.mint_session(owner);
        assert!(state.is_admin(&bearer(&owner_token)).await);
        // A session for any other wallet → not admin.
        let other_token = state
            .0
            .auth
            .mint_session("0x00000000000000000000000000000000000000ff");
        assert!(!state.is_admin(&bearer(&other_token)).await);
        // No session at all → not admin.
        assert!(!state.is_admin(&HeaderMap::new()).await);
    }

    #[tokio::test]
    async fn no_admin_wallet_is_fail_closed() {
        // No owner resolved (LogSettlement.owner() → None), even a valid
        // session is not admin.
        let state = test_state(false, None);
        let token = state
            .0
            .auth
            .mint_session("0xAbC0000000000000000000000000000000000001");
        assert!(!state.is_admin(&bearer(&token)).await);
    }
}
