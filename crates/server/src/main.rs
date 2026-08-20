//! Chess game server: HTTP for game creation + matchmaking (Park/Patzer,
//! Gauntlet queue, Tournament) and a WebSocket hub connecting bring-your-own-
//! engine player clients and spectators to per-game room actors.
//!
//! Durable state (games, moves, results) is persisted to Postgres when
//! `DATABASE_URL` is set; lobby/matchmaking state is in-memory (the Redis layer
//! in production). Onchain settlement is wired when `RPC_URL`/`ESCROW_ADDR`/
//! `ORACLE_KEY` are set, else it logs.

mod admin;
mod agents;
mod alert;
mod auth;
mod matchmaking;
mod players;
mod ratelimit;
mod room;
mod singlenode;
mod username;
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

/// How long a connected bot agent has to accept a seat assignment before it is
/// treated as gone. Generous for a socket that is being read at all, and short
/// enough that one unresponsive agent cannot stall a tournament round.
pub const AGENT_DISPATCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

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
    /// The admin wallet. When `admin_configured` this is authoritative; when
    /// it is chain-derived this is only a CACHE for display (`/config`) and is
    /// never used to authorize — see `AppState::admin_wallet`.
    pub admin_wallet: Mutex<Option<String>>,
    /// `ADMIN_WALLET` was explicitly set. A configured admin is static by
    /// definition; a chain-derived one is not, and the difference decides
    /// whether authorization may be answered from memory.
    pub admin_configured: bool,
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

/// Identity for one seat. `name`/`engine` are self-declared — informational
/// only, never used for auth or money. `wallet` is not: it is the
/// SIWE-authenticated wallet the seat was handed to, and it is what makes the
/// finished game show up in that player's history, record and rating.
#[derive(Clone, Default)]
pub struct SeatMeta {
    pub name: Option<String>,
    pub engine: Option<String>,
    /// The authenticated wallet sitting in this seat, when there is one
    /// (anonymous casual seats have none). For a bot seat this is its owner's
    /// wallet — the same wallet the agent registry is keyed on.
    pub wallet: Option<String>,
}

/// Which ladder a game counts for.
///
/// Money is the only thing that makes a game ranked, and a per-game stake says
/// so on its own — so this exists for the one case where the money sits
/// upstream of the game: a tournament that charged a buy-in, whose pairings
/// carry no stake of their own (the pool settles separately).
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub enum Ladder {
    /// Free play. Moves the separate casual Elo, never the ranked one.
    #[default]
    Casual,
    Ranked,
}

/// Resolve the wallet recorded for each seat, `[white, black]`.
///
/// A wagered seat takes its wallet from the escrow addresses: money is the
/// authoritative binding, and those are the addresses settlement will pay.
/// Everything else falls back to the authenticated wallet that took the seat.
/// The fallback is the whole point — a casual game used to record no wallet at
/// all, so a played game was invisible to `/players/{addr}/games`, to the
/// win/loss record, and to the casual ladder.
pub fn seat_wallets(wager: Option<WagerSeats>, meta: &[SeatMeta; 2]) -> [Option<String>; 2] {
    [
        wager
            .map(|w| w.white.to_string())
            .or_else(|| meta[0].wallet.clone()),
        wager
            .map(|w| w.black.to_string())
            .or_else(|| meta[1].wallet.clone()),
    ]
}

/// The house bot's wallet (lowercased) from `HOUSE_WALLET`, if configured.
fn house_wallet() -> Option<String> {
    std::env::var("HOUSE_WALLET")
        .ok()
        .map(|w| w.trim().to_lowercase())
        .filter(|w| !w.is_empty())
}

/// The house bot's own display name (`HOUSE_USERNAME`, default `HouseBot`).
fn house_username() -> String {
    std::env::var("HOUSE_USERNAME")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "HouseBot".into())
}

/// Give the house bot's wallet its handle at boot, if it hasn't got one.
///
/// Without this the lobby's own bot renders as a hex address, because a seat's
/// label is now resolved from its wallet's username and `scripts/house-bot.sh`
/// has no way to claim one: `house`/`housebot` are on `username::RESERVED`, so
/// `PUT /profile/username` refuses them — deliberately, since a lookalike in the
/// offers table is exactly what that list exists to prevent. The bot may not
/// claim it and nobody else may either, which leaves the server to grant it.
///
/// Idempotent, and cheap to leave in: `set_username` treats re-submitting the
/// name a wallet already holds as a no-op that doesn't touch the cooldown, so
/// every restart after the first is one query that changes nothing. Purely
/// cosmetic, so every failure is a log line — a server that cannot name its bot
/// must still boot and serve games.
async fn ensure_house_username(state: &AppState) {
    let (Some(db), Some(wallet)) = (state.0.db.as_ref(), house_wallet()) else {
        return;
    };
    let name = house_username();
    // Bypass the RESERVED list — that is the point of this function — but never
    // the grammar. `persistence::set_username` validates nothing (the rules live
    // in the HTTP layer), so an unchecked env var writes straight past every
    // constraint the rest of the system assumes: `HOUSE_USERNAME="House Bot"` —
    // the name this bot used to post under, and so the likeliest thing for
    // someone to set — stored a handle with a space in it, which the profile
    // then advertised while `/players/House%20Bot` 404'd and the canonical URL
    // carried a raw space. Every stored username has to stay routable.
    if !username::is_username_shape(&name) {
        tracing::warn!(%name, "HOUSE_USERNAME is not a valid username; leaving the house bot unnamed");
        return;
    }
    match db.set_username(&wallet, &name).await {
        Ok(persistence::SetUsernameOutcome::Set { username }) => {
            tracing::info!(%wallet, %username, "house bot username")
        }
        // Somebody else holds it, or the bot renamed too recently. Neither is
        // worth failing a boot over; the lobby falls back to the short address.
        Ok(other) => tracing::warn!(%wallet, %name, ?other, "house bot username not set"),
        Err(e) => tracing::warn!(%wallet, "house bot username failed: {e:#}"),
    }
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

/// Onchain seats + stake for a wagered game.
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
    // Who may toggle maintenance: ADMIN_WALLET override, else the onchain
    // escrow owner (read live so it tracks ownership transfers).
    let (admin_wallet, admin_configured) = resolve_admin_wallet(&*settlement).await;
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
        admin_configured,
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
            problems.push("onchain settlement not configured (RPC_URL/ESCROW_ADDR/ORACLE_KEY)");
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
            "production profile OK (db + onchain settlement + SIWE_DOMAIN + WEB_ORIGIN)"
        );
    }

    // Drain the per-game + tournament settlement outboxes onchain (durable).
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
    // Supervised like every other long-lived worker: if this dies silently,
    // rooms/tokens never evict and `max_rooms` eventually 503s every new game.
    // The mpsc receiver can't be recreated on restart, so it rides an Arc-Mutex
    // that each incarnation re-locks.
    {
        let st = state.clone();
        let rx = Arc::new(tokio::sync::Mutex::new(cleanup_rx));
        supervise("cleanup", move || cleanup_task(st.clone(), rx.clone()));
    }
    {
        let st = state.clone();
        supervise("sweep", move || sweep_task(st.clone()));
    }
    // Keep each live tournament's displayed prize pool current. Sponsorship is
    // sent by the sponsor's own browser, so there is no server-side event to
    // react to — the pool has to be polled or the prize table shows stale
    // numbers. Display only; settlement re-reads the chain itself.
    {
        let st = state.clone();
        supervise("pool-refresh", move || {
            matchmaking::pool_refresh_task(st.clone())
        });
    }
    // Backstop for the one misconfiguration this server can't survive: a second
    // machine. deploy-server.sh asserts the count, but only for deploys that go
    // through it — a bare `fly deploy` re-adds the HA machine and never does.
    supervise("single-node-watch", singlenode::watch);
    // Update mode standings (gauntlet/tournament) as games finish. Supervised:
    // if this dies, every running tournament stalls mid-round forever and its
    // pool never settles.
    {
        let st = state.clone();
        let rx = Arc::new(tokio::sync::Mutex::new(results_rx));
        supervise("results", move || {
            matchmaking::results_task(st.clone(), rx.clone())
        });
    }
    // Recover tournaments interrupted by a restart: settle completed ones by
    // result, mark interrupted ones abandoned (entrants refund onchain).
    matchmaking::recover_tournaments(&state).await;

    ensure_house_username(&state).await;

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
        .merge(
            auth::routes().route_layer(axum::middleware::from_fn_with_state(
                state.clone(),
                rate_limit_auth,
            )),
        )
        .merge(admin::routes())
        .merge(matchmaking::routes())
        // Throttle the public read routes per-IP: cheap per hit, but the
        // leaderboard query is heavy, so cap how fast one IP can trigger it.
        .merge(
            players::routes().route_layer(axum::middleware::from_fn_with_state(
                state.clone(),
                rate_limit_reads,
            )),
        )
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
/// Returns `(wallet, configured)`. `configured` distinguishes an explicitly
/// set `ADMIN_WALLET` — static, and safe to answer from memory forever — from
/// an owner read off the escrow contract, which can change under us and must
/// be re-read before it authorizes anything.
async fn resolve_admin_wallet(settlement: &dyn SettlementSink) -> (Option<String>, bool) {
    if let Ok(raw) = std::env::var("ADMIN_WALLET") {
        match raw.trim().parse::<Address>() {
            Ok(a) => {
                let a = format!("{a:?}").to_lowercase();
                tracing::info!(admin = %a, "admin wallet from ADMIN_WALLET");
                return (Some(a), true);
            }
            Err(_) => tracing::warn!("ADMIN_WALLET is not a valid address; ignoring"),
        }
    }
    match settlement.owner().await {
        Some(owner) => {
            let a = format!("{owner:?}").to_lowercase();
            tracing::info!(admin = %a, "admin wallet from escrow owner()");
            (Some(a), false)
        }
        None => {
            tracing::warn!(
                "no admin wallet resolved (ADMIN_WALLET unset, escrow owner() unavailable); \
                 maintenance toggle disabled"
            );
            (None, false)
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

/// Readiness: distinct from liveness `/health` — answers "should this node take
/// traffic", so it must fail whenever the node is running but cannot honor its
/// durability guarantee.
async fn ready(State(state): State<AppState>) -> Result<&'static str, StatusCode> {
    // Memo of the last DB ping. /ready is unauthenticated (Fly's checks and the
    // deploy script must never be throttled away from it), so without this
    // every stray external hit costs a round-trip from the 10-connection pool.
    static READY_MEMO: Mutex<Option<(std::time::Instant, bool)>> = Mutex::new(None);
    const READY_MEMO_TTL: std::time::Duration = std::time::Duration::from_secs(2);

    match &state.0.db {
        // Configured: pull the node from the load balancer if Postgres is gone.
        Some(db) => {
            let memoed = (*READY_MEMO.lock()).filter(|(at, _)| at.elapsed() < READY_MEMO_TTL);
            let ok = match memoed {
                Some((_, ok)) => ok,
                None => {
                    let ok = db.ping().await.is_ok();
                    *READY_MEMO.lock() = Some((std::time::Instant::now(), ok));
                    ok
                }
            };
            if !ok {
                return Err(StatusCode::SERVICE_UNAVAILABLE);
            }
        }
        // No database at all. Fine for a casual-only node — nothing is at stake
        // and in-memory state is the whole design. NOT fine once onchain
        // settlement is live: the settlement outbox workers are only spawned
        // when a DB exists, so such a node accepts real wagers and settles them
        // "best-effort inline" (see `room.rs finish()`) with no retry — one
        // transient RPC failure strands the stake until the contract's
        // claimTimeout. This branch used to fall through to `ready`, which is
        // exactly how a production node ran without Postgres unnoticed: every
        // health check was green while the durability guarantee was absent.
        None => {
            if state.0.settlement.is_onchain() {
                tracing::error!(
                    "not ready: onchain settlement is configured but DATABASE_URL is unset — \
                     no settlement outbox, so wagers would settle with no retry. Attach Postgres \
                     (and set REQUIRE_ONCHAIN=1 to fail the boot instead of serving)."
                );
                return Err(StatusCode::SERVICE_UNAVAILABLE);
            }
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
    /// Whether wagered play is available (onchain settlement is configured).
    wager_enabled: bool,
    /// Domain SIWE messages must be bound to — native clients need it to build
    /// a message this server will accept.
    siwe_domain: String,
    /// Whether the server is in maintenance/drain mode: no new games start,
    /// existing ones play out. Clients show a banner + disable "create".
    maintenance: bool,
    /// The wallet allowed to toggle maintenance (the onchain escrow owner).
    /// Public — it's readable onchain — so the UI can show the admin control
    /// only to that wallet. `None` ⇒ admin actions disabled on this server.
    admin_wallet: Option<String>,
    /// The house bot's wallet (lowercased), so the lobby can identify its
    /// standing offers for the "play now" button. `None` ⇒ no shortcut.
    ///
    /// This used to be done by matching the offer's display name against the
    /// literal `"House Bot"`, which stopped working the moment an offer's label
    /// became a server-resolved username — `"House Bot"` has a space in it and
    /// can never be one. Matching the address is strictly better anyway: a
    /// display string was spoofable, and the old code could only mitigate that
    /// by restricting the shortcut to free offers.
    house_wallet: Option<String>,
}

/// Public snapshot of an in-progress game, for the spectate lobby.
#[derive(Clone, Serialize)]
pub struct LiveGame {
    pub game_id: GameId,
    pub mode: String,
    /// Each seat's wallet — the escrow addresses when wagered, else whoever
    /// signed in for the seat. `None` for anonymous engine-vs-engine games.
    pub white: Option<String>,
    pub black: Option<String>,
    /// Each seat's RESOLVED username, or `None` when that wallet has not
    /// claimed one (and for an anonymous seat). Deliberately not filled with a
    /// shortened address: these have always been `None` whenever nothing was
    /// declared, and the spectate lobby already falls back to `white`/`black`,
    /// so substituting a short address here would change every live row for no
    /// gain. A snapshot taken at game start — a rename mid-game shows the old
    /// name until the game ends, which is fine at minutes-per-game and one
    /// rename per week.
    pub white_name: Option<String>,
    pub black_name: Option<String>,
    /// Self-declared engines (informational, sanitized, never verified).
    pub white_engine: Option<String>,
    pub black_engine: Option<String>,
    pub stake: Option<String>,
    /// Which ladder it counts for. Free-but-ranked happens (a buy-in
    /// tournament), so a viewer keyed on `stake` alone would mislabel it.
    pub rated: bool,
    pub initial_secs: u64,
    pub increment_secs: u64,
    pub created_ms: u64,
}

/// List in-progress games so the lobby can offer them to spectate. Only games
/// that have actually begun (both engines connected + ready) are listed — not
/// idle rooms still waiting for connections, and never a `TEST_MODE` game (see
/// that constant: nobody is seated in one, so listing it is an invitation to
/// watch a stranger's private sandbox).
async fn live_games(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<LiveGame>>, StatusCode> {
    // The last of the 3s lobby polls to join the polls bucket: every hit
    // clones + sorts the live-games map under two locks.
    state.reject_if_rate_limited_polls(&headers)?;
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
        .filter(|g| started.contains(&g.game_id) && g.mode != TEST_MODE)
        .cloned()
        .collect();
    // Newest first.
    list.sort_by_key(|g| std::cmp::Reverse(g.created_ms));
    Ok(Json(list))
}

/// Publishes the onchain config the web app needs to wire deposits/wagers:
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
        // Advisory: lets the owner's browser show the admin controls. The
        // server re-derives the real answer per request in `is_admin`, so a
        // stale value here can only mis-draw a button, never grant anything.
        admin_wallet: state.0.admin_wallet.lock().clone(),
        house_wallet: house_wallet(),
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
///
/// The receiver arrives in an Arc-Mutex because `supervise` re-invokes this on
/// panic, and an owned receiver would die with the first incarnation.
async fn cleanup_task(state: AppState, rx: Arc<tokio::sync::Mutex<mpsc::Receiver<GameId>>>) {
    let mut rx = rx.lock().await;
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
        state.0.limits.sweep();
        // The live-game set gates BOTH passes: `sweep_expired` keeps a matched
        // offer/ticket only while its game still exists (so a launch token is
        // never dropped out from under a seated player), and `prune_games`
        // drops routing entries for games that are gone.
        let live: std::collections::HashSet<GameId> =
            state.0.rooms.lock().keys().copied().collect();
        state.0.lobby.sweep_expired(&live);
        state.0.lobby.prune_games(&live);
    }
}

/// Background worker: claims pending settlements and submits them onchain.
/// Transient failures are requeued with an attempt cap; crashed-worker rows are
/// reaped back to pending; an already-settled game (crash-after-submit / replay
/// revert) is treated as success.
async fn settlement_worker(db: Arc<Db>, settlement: Arc<dyn SettlementSink>) {
    use tokio::time::{interval, Duration};
    let mut tick = interval(Duration::from_secs(1));
    loop {
        tick.tick().await;

        // Reap rows stranded in `processing` by a crashed worker. The lease must
        // exceed worst-case onchain confirmation so we don't requeue an
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
                    // Confirm against the CHAIN before recording terminal
                    // success. `report_result` already fails on a reverted
                    // receipt (`OnchainSettlement::confirm`), so this is the
                    // second lock on the same door: "settled" is the one status
                    // with no retry behind it, and marking it on a payout that
                    // did not happen strands the winner's stake until the 24h
                    // `refundGame` timeout turns their win into a refund. Read
                    // the flag rather than trusting the submit path to stay
                    // honest through future edits.
                    if settlement.is_onchain() && !settlement.is_settled(row.game_id).await {
                        // Requeue rather than fail: the likeliest cause is an
                        // RPC lagging the block we just mined in, and a retry
                        // self-heals (the resubmit reverts `AlreadySettled`,
                        // and the Err arm below reads the flag as success).
                        let _ = db
                            .requeue_settlement(row.id, Some("submitted but not settled onchain"))
                            .await;
                        tracing::warn!(
                            game_id = %row.game_id,
                            "outbox: submit reported success but the chain says unsettled; requeued"
                        );
                        continue;
                    }
                    let _ = db
                        .finalize_settlement(row.id, row.game_id, "settled", None)
                        .await;
                    tracing::info!(game_id = %row.game_id, "outbox: settled onchain");
                }
                Err(e) => {
                    let msg = e.to_string();
                    // The submit may have actually landed (crash/replay): if the
                    // chain says it's settled, that's success, not failure.
                    if settlement.is_settled(row.game_id).await {
                        let _ = db
                            .finalize_settlement(row.id, row.game_id, "settled", None)
                            .await;
                        tracing::info!(game_id = %row.game_id, "outbox: already settled onchain");
                    } else if row.attempts >= persistence::MAX_SETTLE_ATTEMPTS {
                        let _ = db
                            .finalize_settlement(row.id, row.game_id, "failed", Some(&msg))
                            .await;
                        tracing::error!(game_id = %row.game_id, attempts = row.attempts, "outbox: giving up: {msg}");
                        alert::fire(format!(
                            "🚨 OpenChess: settlement outbox GAVE UP on game {} after {} attempts. \
                             The stake was not paid out onchain. err: {msg}",
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
                    // Same second lock as the game worker above: never record
                    // terminal success on a pool the chain doesn't agree was
                    // settled. Requeue instead, so an RPC lagging the block
                    // self-heals on the next tick.
                    if settlement.is_onchain() && !settlement.is_tournament_settled(row.tid).await {
                        let _ = db
                            .set_tournament_settlement_status(
                                row.id,
                                "pending",
                                Some("submitted but not settled onchain"),
                            )
                            .await;
                        tracing::warn!(
                            tid = %row.tid,
                            "tournament outbox: submit reported success but the chain says \
                             unsettled; requeued"
                        );
                        continue;
                    }
                    let _ = db
                        .set_tournament_settlement_status(row.id, "settled", None)
                        .await;
                    tracing::info!(tid = %row.tid, "tournament outbox: settled onchain");
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
                             after {} attempts. Payouts were not made onchain. err: {msg}",
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
    /// [white, black] display identity, resolved exactly as the room will show
    /// it. Internal handoff to matchmaking, which tells each side who it drew
    /// before the game starts — `GameStart` carries the same thing but only
    /// once both seats have readied. Not part of the `/games` response body.
    #[serde(skip)]
    pub players: [protocol::OpponentInfo; 2],
}

/// The mode `/games` records, and the one mode `/games/live` hides.
///
/// This route has exactly one caller — the web app's Test Engine page — and what
/// it makes is two in-browser Stockfish workers playing each other on the
/// visitor's own CPU. Nobody is seated: it is unauthenticated, so both seat
/// wallets are NULL and the game has always been absent from every player's
/// history and from both Elo ladders. It appeared in the spectate lobby anyway,
/// which advertised a private sandbox as a live table and let anyone fill "Live
/// now" with games no player is in.
///
/// Named rather than left as `"casual"`, because that word now means the free
/// half of a real ladder (`games.rated`) and a mode string reading "casual" is
/// the wrong thing to filter a lobby on.
pub const TEST_MODE: &str = "test";

/// `/games` creates an **unwagered, unseated** test game with two open seats —
/// the Test Engine sandbox. Real games go through the authenticated
/// Park/Gauntlet/Tournament matchmaking flows, where each seat is bound to the
/// wallet that consented to it.
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
            TEST_MODE,
            None,
            Ladder::Casual,
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
        ladder: Ladder,              // ranked only when money is upstream (buy-in)
        meta: [SeatMeta; 2],         // [white, black] self-declared identity
        delivery: [SeatDelivery; 2], // [white, black] seat delivery
    ) -> Result<CreateGameResp, StatusCode> {
        self.start_game_registered(tc, mode, wager, ladder, meta, delivery, None)
            .await
    }

    /// `start_game`, plus a hook that runs once the game exists but **before
    /// any seat can be played**.
    ///
    /// A mode that routes a game's outcome somewhere (today: tournaments, via
    /// `game_to_tournament`) has to have that routing in place before it hands
    /// out the capability to play, because the outcome can arrive the instant
    /// it does. `dispatch_round` used to register the whole round after its
    /// start loop finished, on the reasoning that a real game cannot end in the
    /// sub-millisecond gap — but the gap was not sub-millisecond. Delivering a
    /// seat to a bot agent pushes onto a 16-slot channel drained by a task that
    /// awaits the agent's socket, so an entrant whose agent simply stops
    /// reading held the loop open for as long as it liked. Their earlier
    /// pairing was live and playable that whole time, and an outcome with no
    /// routing entry is silently dropped by `record_outcome` — leaving
    /// `round_remaining` stuck above zero and the event, with its real pool,
    /// unable to advance or settle.
    ///
    /// The hook is therefore called after the room, the persisted row and the
    /// launch tokens exist, and before the first `AssignSeat` goes out.
    #[allow(clippy::too_many_arguments)]
    pub async fn start_game_registered(
        &self,
        tc: TimeControl,
        mode: &str,
        wager: Option<WagerSeats>,
        ladder: Ladder,              // ranked only when money is upstream (buy-in)
        meta: [SeatMeta; 2],         // [white, black] self-declared identity
        delivery: [SeatDelivery; 2], // [white, black] seat delivery
        register: Option<&(dyn Fn(GameId) + Send + Sync)>,
    ) -> Result<CreateGameResp, StatusCode> {
        // Maintenance/drain: the single chokepoint every mode funnels through,
        // so one guard blocks all new games while existing ones play out.
        self.reject_if_draining()?;

        // Global room ceiling: bound concurrent room actors so a creation flood
        // can't exhaust memory/tasks on the single node. Checked here (before any
        // escrow opens) so a rejected wagered game never locks funds onchain.
        // Best-effort: the check isn't atomic with the insert below, so a
        // concurrent burst can overshoot by the number of in-flight creates —
        // that's bounded by the per-IP create throttle and fine for a DoS backstop.
        if self.0.rooms.lock().len() >= self.0.limits.max_rooms {
            tracing::warn!(
                "refusing new game: room ceiling reached ({})",
                self.0.limits.max_rooms
            );
            return Err(StatusCode::SERVICE_UNAVAILABLE);
        }

        let game_id = Uuid::new_v4();
        let stake_info = wager.map(|w| StakeInfo {
            white: w.white,
            black: w.black,
        });

        // Fail-closed: never accept a wager we cannot settle onchain, or with
        // identical / overflowing seats.
        if let Some(w) = wager {
            if !self.0.settlement.is_onchain() {
                tracing::warn!(%game_id, "refusing wagered game: no onchain settlement configured");
                return Err(StatusCode::SERVICE_UNAVAILABLE);
            }
            if w.white == w.black || w.stake == U256::ZERO || w.stake > U256::from(MAX_STAKE) {
                return Err(StatusCode::BAD_REQUEST);
            }
        }

        // Who owns each seat, wagered or not — see `seat_wallets`.
        let wallets = seat_wallets(wager, &meta);
        // Which ladder it counts for. OR-ing with the wager is the fail-safe
        // direction: a caller can forget to ask for Ranked, but a game with a
        // stake on it can never be recorded casual by that omission.
        let rated = wager.is_some() || ladder == Ladder::Ranked;

        // Persist the game row. For a wagered game this must succeed (fail-closed).
        if let Some(db) = &self.0.db {
            let pwager = match wager {
                Some(w) => Some(PgWager {
                    white_addr: w.white.to_string(),
                    black_addr: w.black.to_string(),
                    // Already bounded by the MAX_STAKE check above; try_from is
                    // for the caller that one day skips it — a 400 beats a
                    // panicking cast in the one function every mode funnels
                    // through.
                    stake: Decimal::from(
                        u128::try_from(w.stake).map_err(|_| StatusCode::BAD_REQUEST)?,
                    ),
                }),
                None => None,
            };
            if let Err(e) = db
                .create_game(
                    game_id,
                    mode,
                    rated,
                    wallets[0].as_deref(),
                    wallets[1].as_deref(),
                    PgTc {
                        initial_ms: tc.initial_ms as i64,
                        increment_ms: tc.increment_ms as i64,
                    },
                    pwager.as_ref(),
                    [meta[0].engine.as_deref(), meta[1].engine.as_deref()],
                )
                .await
            {
                tracing::error!(%game_id, "persist create_game failed: {e:#}");
                if wager.is_some() {
                    return Err(StatusCode::INTERNAL_SERVER_ERROR);
                }
            }
        }

        // Lock stakes onchain BEFORE spawning the room. If this fails for a
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

        // Display identity is SERVER-OWNED. One batched read, here rather than
        // in the closure below because this is the last await point before it —
        // and `start_game` is the single chokepoint every mode funnels through,
        // already awaiting Postgres several times, so this costs one more query
        // per game and needs no cache to invalidate on a rename.
        let usernames = match &self.0.db {
            Some(db) => {
                let want: Vec<String> = wallets.iter().flatten().cloned().collect();
                db.usernames_for(&want).await.unwrap_or_default()
            }
            None => Default::default(),
        };

        // Resolve each seat's display identity.
        //
        // Precedence is username -> shortened wallet, and only a seat with NO
        // wallet ever falls through to a client-supplied label (decorated, so it
        // cannot read as a handle) and then to "anonymous".
        //
        // **A seat with a wallet never reads `m.name`, and that is the whole
        // enforcement.** If a signed-in player without a username could have
        // their declared string rendered, they could declare somebody else's
        // username and the board would print it. Falling back to the short
        // address instead is strictly less pretty and strictly not forgeable.
        //
        // No database (dev, tests) means no usernames and every seat falls
        // straight through to its short address — what this did before, minus
        // the declared names. There is nothing to fail closed against: a display
        // label is not a money path.
        let seat_info = |m: &SeatMeta, wallet: Option<&String>| {
            let username = wallet.and_then(|w| usernames.get(&w.to_lowercase()).cloned());
            protocol::OpponentInfo {
                name: match wallet {
                    Some(w) => username.clone().unwrap_or_else(|| short_addr(w)),
                    None => m
                        .name
                        .as_deref()
                        .map(username::guest_label)
                        .unwrap_or_else(|| "anonymous".into()),
                },
                username,
                declared_engine: m.engine.clone(),
            }
        };
        let players = [
            seat_info(&meta[0], wallets[0].as_ref()),
            seat_info(&meta[1], wallets[1].as_ref()),
        ];

        let handle = spawn_room(
            game_id,
            tc,
            self.0.settlement.clone(),
            stake_info,
            players.clone(),
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
                white: wallets[0].clone(),
                black: wallets[1].clone(),
                white_name: players[0].username.clone(),
                black_name: players[1].username.clone(),
                white_engine: meta[0].engine.clone(),
                black_engine: meta[1].engine.clone(),
                stake: wager.map(|w| w.stake.to_string()),
                rated,
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
        // Everything the game needs in order to be findable now exists (room,
        // persisted row, launch tokens) and nothing can play it yet. This is
        // the only safe point to register outcome routing — see the doc
        // comment above.
        if let Some(register) = register {
            register(game_id);
        }

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
            // BOUNDED, never a bare `.await`. The agent channel holds 16 and
            // is drained by a task that awaits the agent's own socket, so an
            // agent that stops reading applies backpressure right back into
            // this loop. Awaiting it let one unresponsive entrant hold up
            // every other pairing in a tournament round indefinitely (and any
            // other caller of `start_game`, park accept included). An agent
            // that cannot take a seat assignment within the timeout is treated
            // exactly like one that vanished: the game is aborted and refunded,
            // and the caller scores it as a no-show.
            let sent = tx
                .send_timeout(
                    protocol::ServerToAgent::AssignSeat {
                        game_id,
                        token: token.clone(),
                        color,
                        time_control: tc,
                        stake: stake_str.clone(),
                        uci_options: uci_options.clone(),
                    },
                    AGENT_DISPATCH_TIMEOUT,
                )
                .await;
            if sent.is_err() {
                tracing::error!(%game_id, %wallet, ?color, "agent did not take its seat (gone or not reading) — aborting game");
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
            players,
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

    /// Like `authed_wallet`, but tells "no credential offered" apart from "a
    /// credential was offered and it is not valid".
    ///
    /// Silently downgrading a stale token to anonymous is a footgun on routes
    /// where auth is optional. An autopilot posts what it believes is a
    /// wallet-bound challenge; the session has since expired (they live in
    /// this process's memory, so any restart voids them); the server records
    /// no `poster_addr`; and the client's own self-match guard — which keys on
    /// `poster_addr` — then fails open against its own offer. Observed in
    /// production as the house bot repeatedly joining its own challenge and
    /// having the game rejected for same-wallet seats. Fail loudly instead, so
    /// the caller re-authenticates rather than posting as a stranger.
    pub fn authed_wallet_strict(&self, headers: &HeaderMap) -> Result<Option<String>, StatusCode> {
        let Some(value) = headers.get("authorization") else {
            return Ok(None); // genuinely anonymous — legitimate for casual play
        };
        let token = value
            .to_str()
            .ok()
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or(StatusCode::UNAUTHORIZED)?;
        self.0
            .auth
            .wallet_for_token(token)
            .map(Some)
            .ok_or(StatusCode::UNAUTHORIZED)
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
    /// call spawns a room actor and/or an oracle-gas-costing onchain tx, so
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

    /// Per-IP throttle for the matchmaking **polling GETs** (`/park/offers`,
    /// `/tournaments`, `/queue/{id}`, …). Same in-handler pattern as `create`
    /// and for the same reason (shared router paths); its own generous bucket
    /// so a scripted flood of the heavy tournament view can't ride for free,
    /// while a poll-heavy tab never eats the budget needed to start a game.
    pub fn reject_if_rate_limited_polls(&self, headers: &HeaderMap) -> Result<(), StatusCode> {
        let ip = ratelimit::client_ip(headers);
        if self.0.limits.polls.check(&ip).is_some() {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        Ok(())
    }

    /// The wallet allowed to administer the server, **re-read from the chain on
    /// every call** unless it was explicitly configured.
    ///
    /// The owner used to be read once at boot and cached for the life of the
    /// process. The escrow is `Ownable2Step`, so a completed
    /// `transferOwnership`/`acceptOwnership` left the server authorizing the
    /// PREVIOUS owner and rejecting the current one — privilege revocation
    /// simply did not take. The old owner kept the maintenance switch, which is
    /// DB-persisted, so they could stop every new game on the platform and have
    /// it survive the restarts meant to undo it.
    ///
    /// Only `set_maintenance` reaches this, so a view call per privileged
    /// mutation costs nothing worth optimising. An RPC failure returns `None`
    /// and nobody is admin — fail-closed, matching the boot behaviour: losing
    /// the pause switch for a moment is strictly better than handing it to
    /// whoever held it last.
    async fn admin_wallet(&self) -> Option<String> {
        // Explicitly configured: static, and there is no chain to consult.
        if self.0.admin_configured {
            return self.0.admin_wallet.lock().clone();
        }
        let owner = self.0.settlement.owner().await?;
        let w = format!("{owner:?}").to_lowercase();
        // Refresh the advisory copy `/config` publishes, so the UI follows a
        // transfer too. This is a cache of what we just read, never the source
        // of the decision above.
        *self.0.admin_wallet.lock() = Some(w.clone());
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
        test_state_with_settlement(maintenance, admin_wallet, Arc::new(ledger::LogSettlement))
    }

    /// As `test_state`, but with the settlement sink chosen by the caller — the
    /// readiness guard keys off whether money is live, not just off the DB.
    fn test_state_with_settlement(
        maintenance: bool,
        admin_wallet: Option<&str>,
        settlement: Arc<dyn ledger::SettlementSink>,
    ) -> AppState {
        let (cleanup_tx, _cleanup_rx) = mpsc::channel::<GameId>(8);
        let (results_tx, _results_rx) = mpsc::channel::<GameOutcome>(8);
        AppState(Arc::new(Inner {
            rooms: Mutex::new(HashMap::new()),
            live_games: Mutex::new(HashMap::new()),
            tokens: Mutex::new(HashMap::new()),
            settlement,
            db: None,
            maintenance: AtomicBool::new(maintenance),
            admin_wallet: Mutex::new(admin_wallet.map(|w| w.to_lowercase())),
            // An explicitly-passed wallet stands in for a configured
            // ADMIN_WALLET; `None` leaves authority chain-derived, which is the
            // case the fail-closed and ownership-transfer tests exercise.
            admin_configured: admin_wallet.is_some(),
            lobby: Lobby::default(),
            auth: auth::Auth::default(),
            agents: agents::Agents::default(),
            limits: ratelimit::RateLimits::from_env(),
            cleanup_tx,
            results_tx,
        }))
    }

    /// `test_state` with a real Postgres behind it, so a test can look at the
    /// row `start_game` actually wrote. The settlement sink is a parameter
    /// because a wagered game is refused outright unless one is onchain.
    fn test_state_with_db(
        db: Arc<persistence::Db>,
        settlement: Arc<dyn ledger::SettlementSink>,
    ) -> AppState {
        let (cleanup_tx, _cleanup_rx) = mpsc::channel::<GameId>(8);
        let (results_tx, _results_rx) = mpsc::channel::<GameOutcome>(8);
        AppState(Arc::new(Inner {
            rooms: Mutex::new(HashMap::new()),
            live_games: Mutex::new(HashMap::new()),
            tokens: Mutex::new(HashMap::new()),
            settlement,
            db: Some(db),
            maintenance: AtomicBool::new(false),
            admin_wallet: Mutex::new(None),
            admin_configured: false,
            lobby: Lobby::default(),
            auth: auth::Auth::default(),
            agents: agents::Agents::default(),
            limits: ratelimit::RateLimits::from_env(),
            cleanup_tx,
            results_tx,
        }))
    }

    /// The join the two halves either side of this can't see: the seat wallets
    /// have to reach the `games` row, because that row is the only thing
    /// `/players/{addr}/games`, the W/L/D record and Elo ever read.
    /// Runs only when DATABASE_URL is set (local Postgres).
    #[tokio::test]
    async fn a_casual_game_persists_its_seat_wallets() {
        let Ok(url) = std::env::var("DATABASE_URL") else {
            eprintln!("skipping: DATABASE_URL not set");
            return;
        };
        let db = Arc::new(persistence::Db::connect(&url).await.expect("connect"));
        db.migrate().await.expect("migrate");
        let state = test_state_with_db(db.clone(), Arc::new(ledger::LogSettlement));

        let white = "0xaa11111111111111111111111111111111111111";
        let black = "0xbb22222222222222222222222222222222222222";
        let seat = |w: &str| SeatMeta {
            wallet: Some(w.into()),
            ..Default::default()
        };
        let resp = state
            .start_game(
                TC,
                "park",
                None, // no stake: the case that used to record nobody
                Ladder::Casual,
                [seat(white), seat(black)],
                [SeatDelivery::Browser, SeatDelivery::Browser],
            )
            .await
            .expect("casual game starts");

        let row = db
            .game_detail(resp.game_id)
            .await
            .expect("query")
            .expect("row exists");
        assert_eq!(row.white_wallet.as_deref(), Some(white));
        assert_eq!(row.black_wallet.as_deref(), Some(black));
        assert_eq!(row.stake, None, "wallets recorded without a wager");
        assert!(
            !row.rated,
            "and it's a free game, so it's on the casual ladder"
        );
    }

    /// The impersonation guard, and the most important test in the username
    /// change.
    ///
    /// A seat that has a wallet must render that wallet's username — or, failing
    /// that, its short address — and must NEVER render a string the client
    /// supplied. Otherwise a signed-in player with no username of their own
    /// could declare somebody else's and the board would print it.
    /// Runs only when DATABASE_URL is set (local Postgres).
    #[tokio::test]
    async fn a_seat_shows_its_wallets_username_not_the_string_the_client_sent() {
        let Ok(url) = std::env::var("DATABASE_URL") else {
            eprintln!("skipping: DATABASE_URL not set");
            return;
        };
        let db = Arc::new(persistence::Db::connect(&url).await.expect("connect"));
        db.migrate().await.expect("migrate");
        let state = test_state_with_db(db.clone(), Arc::new(ledger::LogSettlement));

        // A unique handle per run, so this doesn't collide with a rerun.
        let tag = Uuid::new_v4().simple().to_string();
        let handle = format!("alice{}", &tag[..8]);
        // 0x + 40 hex: a real address shape, since that is what the fallback
        // shortens. `tag` is a 32-char simple UUID, so pad to length.
        let named = format!("0xaa{tag}aaaaaa");
        let nameless = format!("0xbb{tag}bbbbbb");
        db.set_username(&named, &handle).await.expect("claim");

        let resp = state
            .start_game(
                TC,
                "park",
                None,
                Ladder::Casual,
                [
                    SeatMeta {
                        wallet: Some(named.clone()),
                        // Ignored: this seat has a wallet.
                        name: Some("someone else".into()),
                        ..Default::default()
                    },
                    SeatMeta {
                        wallet: Some(nameless.clone()),
                        // The attack: claim the handle the other seat owns.
                        name: Some(handle.clone()),
                        ..Default::default()
                    },
                ],
                [SeatDelivery::Browser, SeatDelivery::Browser],
            )
            .await
            .expect("game starts");

        // The wallet that owns the handle gets it, verified.
        assert_eq!(resp.players[0].name, handle);
        assert_eq!(resp.players[0].username.as_deref(), Some(&*handle));
        // The one that doesn't falls back to its address — the declared string
        // appears nowhere, and nothing is presented as a verified handle.
        assert_eq!(resp.players[1].name, short_addr(&nameless));
        assert_eq!(resp.players[1].username, None);

        // And the live-games row carries usernames only, never a substitute.
        let live = state.0.live_games.lock();
        let g = live.get(&resp.game_id).expect("game is live");
        assert_eq!(g.white_name.as_deref(), Some(&*handle));
        assert_eq!(g.black_name, None);
    }

    /// The other half: a seat with NO wallet may carry a chosen label, but it is
    /// decorated so it can never be read as a claimed handle.
    #[tokio::test]
    async fn an_anonymous_seats_declared_label_is_marked_as_one() {
        let state = test_state(false, None);
        let resp = state
            .start_game(
                TC,
                "park",
                None,
                Ladder::Casual,
                [
                    SeatMeta {
                        name: Some("alice".into()),
                        ..Default::default()
                    },
                    SeatMeta::default(),
                ],
                [SeatDelivery::Browser, SeatDelivery::Browser],
            )
            .await
            .expect("game starts");
        assert_eq!(resp.players[0].name, "~alice");
        assert_eq!(resp.players[0].username, None);
        assert_eq!(resp.players[1].name, "anonymous");
    }

    /// A staked game is ranked whatever the caller asked for. The `Ladder`
    /// argument can only ever ADD rankedness — forgetting to pass `Ranked`
    /// must not be able to file a game with money on it under casual.
    /// Runs only when DATABASE_URL is set (local Postgres).
    #[tokio::test]
    async fn a_staked_game_is_ranked_even_when_the_caller_says_casual() {
        let Ok(url) = std::env::var("DATABASE_URL") else {
            eprintln!("skipping: DATABASE_URL not set");
            return;
        };
        let db = Arc::new(persistence::Db::connect(&url).await.expect("connect"));
        db.migrate().await.expect("migrate");
        let state = test_state_with_db(db.clone(), Arc::new(OnchainStub));

        let wager = WagerSeats {
            white: "0x00000000000000000000000000000000000000a1"
                .parse()
                .unwrap(),
            black: "0x00000000000000000000000000000000000000b2"
                .parse()
                .unwrap(),
            stake: U256::from(1_000_000u64),
        };
        let resp = state
            .start_game(
                TC,
                "park",
                Some(wager),
                Ladder::Casual, // deliberately wrong
                Default::default(),
                [SeatDelivery::Browser, SeatDelivery::Browser],
            )
            .await
            .expect("staked game starts");

        let row = db
            .game_detail(resp.game_id)
            .await
            .expect("query")
            .expect("row exists");
        assert!(row.rated, "money on the game makes it ranked regardless");
    }

    /// The other direction: money upstream of the game (a tournament buy-in)
    /// makes it ranked even though no stake is attached to the pairing.
    /// Runs only when DATABASE_URL is set (local Postgres).
    #[tokio::test]
    async fn a_buy_in_tournament_pairing_is_ranked_without_a_wager() {
        let Ok(url) = std::env::var("DATABASE_URL") else {
            eprintln!("skipping: DATABASE_URL not set");
            return;
        };
        let db = Arc::new(persistence::Db::connect(&url).await.expect("connect"));
        db.migrate().await.expect("migrate");
        let state = test_state_with_db(db.clone(), Arc::new(ledger::LogSettlement));

        let resp = state
            .start_game(
                TC,
                "tournament",
                None, // the buy-in is a pool, not a per-game wager
                Ladder::Ranked,
                Default::default(),
                [SeatDelivery::Browser, SeatDelivery::Browser],
            )
            .await
            .expect("tournament game starts");

        let row = db
            .game_detail(resp.game_id)
            .await
            .expect("query")
            .expect("row exists");
        assert!(row.rated);
        assert_eq!(row.stake, None, "ranked with nothing staked on the game");
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

    /// Claims to settle onchain without touching a chain, so the readiness
    /// test can cover the dangerous combination: money live, durability absent.
    struct OnchainStub;

    #[async_trait::async_trait]
    impl ledger::SettlementSink for OnchainStub {
        async fn open_escrow(
            &self,
            _game_id: Uuid,
            _white: Address,
            _black: Address,
            _stake: U256,
        ) -> anyhow::Result<()> {
            Ok(())
        }
        async fn report_result(
            &self,
            _game_id: Uuid,
            _winner: Option<Address>,
        ) -> anyhow::Result<()> {
            Ok(())
        }
        fn is_onchain(&self) -> bool {
            true
        }
    }

    #[test]
    fn strict_auth_rejects_a_stale_bearer_instead_of_going_anonymous() {
        // Regression: a session dies whenever the server restarts (they live
        // in this process's memory). The old behaviour treated the stale token
        // as "no credential" and recorded a casual offer with no poster, which
        // made the client's `poster_addr` self-match guard fail open — the
        // house bot then repeatedly joined its own challenge.
        let state = test_state(false, None);
        let mut h = HeaderMap::new();
        h.insert(
            "authorization",
            "Bearer not-a-real-session".parse().unwrap(),
        );
        assert_eq!(
            state.authed_wallet_strict(&h).err(),
            Some(StatusCode::UNAUTHORIZED)
        );
    }

    #[test]
    fn strict_auth_still_allows_a_genuinely_anonymous_caller() {
        // Negative control: casual play without signing in must keep working,
        // or we'd lock out every browser visitor who never connected a wallet.
        let state = test_state(false, None);
        assert_eq!(state.authed_wallet_strict(&HeaderMap::new()), Ok(None));
    }

    #[test]
    fn strict_auth_accepts_a_live_session() {
        let state = test_state(false, None);
        let token = state.0.auth.mint_session("0xabc");
        let mut h = HeaderMap::new();
        h.insert("authorization", format!("Bearer {token}").parse().unwrap());
        assert_eq!(
            state.authed_wallet_strict(&h),
            Ok(Some("0xabc".to_string()))
        );
    }

    #[tokio::test]
    async fn ready_fails_when_wagering_is_live_but_there_is_no_db() {
        // The state production actually ran in: wager_enabled, no Postgres, so
        // no settlement outbox worker. This must NOT report ready.
        let state = test_state_with_settlement(false, None, Arc::new(OnchainStub));
        let result = ready(State(state)).await;
        assert_eq!(result.err(), Some(StatusCode::SERVICE_UNAVAILABLE));
    }

    #[tokio::test]
    async fn ready_ok_for_a_casual_only_node_without_a_db() {
        // Negative control: a DB-less node is legitimate when nothing is at
        // stake (local dev, casual-only deploys) — the guard keys off money
        // being live, not off the DB alone, so this must still be ready.
        let state = test_state(false, None);
        assert!(ready(State(state)).await.is_ok());
    }

    #[tokio::test]
    async fn maintenance_blocks_new_games() {
        let state = test_state(true, None);
        let result = state
            .start_game(
                TC,
                "casual",
                None,
                Ladder::Casual,
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
                Ladder::Casual,
                Default::default(),
                [SeatDelivery::Browser, SeatDelivery::Browser],
            )
            .await
            .expect("casual game should start when not paused");
        assert!(!resp.white_token.is_empty());
    }

    /// The whole point of the seat wallet: an unstaked game between two
    /// signed-in players is still THEIR game. Recording no wallet is what kept
    /// it out of `/players/{addr}/games`, out of the W/L/D record, and out of
    /// Elo — every one of which reads `games.white_wallet`/`black_wallet`.
    #[test]
    fn a_casual_seat_keeps_the_wallet_that_took_it() {
        let meta = [
            SeatMeta {
                wallet: Some("0xAAa0000000000000000000000000000000000001".into()),
                ..Default::default()
            },
            SeatMeta {
                wallet: Some("0xBbB0000000000000000000000000000000000002".into()),
                ..Default::default()
            },
        ];
        assert_eq!(
            seat_wallets(None, &meta),
            [
                Some("0xAAa0000000000000000000000000000000000001".to_string()),
                Some("0xBbB0000000000000000000000000000000000002".to_string()),
            ]
        );
    }

    #[test]
    fn an_anonymous_seat_records_no_wallet() {
        // Negative control: engine-vs-engine on /play authenticates nothing, and
        // must not be attributed to anyone.
        assert_eq!(seat_wallets(None, &Default::default()), [None, None]);
    }

    #[test]
    fn a_wagered_seat_takes_the_escrow_address_over_the_declared_one() {
        // Money is the authoritative binding: settlement pays the escrow
        // addresses, so history has to name the same wallets even if a seat's
        // metadata says otherwise.
        let white: Address = "0x00000000000000000000000000000000000000a1"
            .parse()
            .unwrap();
        let black: Address = "0x00000000000000000000000000000000000000b2"
            .parse()
            .unwrap();
        let meta = [
            SeatMeta {
                wallet: Some("0x00000000000000000000000000000000000000ff".into()),
                ..Default::default()
            },
            SeatMeta::default(),
        ];
        let wager = WagerSeats {
            white,
            black,
            stake: U256::from(1u64),
        };
        assert_eq!(
            seat_wallets(Some(wager), &meta),
            [Some(white.to_string()), Some(black.to_string())]
        );
    }

    /// End-to-end through `start_game`: the seat wallet reaches the live-game
    /// snapshot (and the display identity) without a stake anywhere in sight.
    #[tokio::test]
    async fn a_casual_game_carries_its_seat_wallets_into_live_state() {
        let state = test_state(false, None);
        let addr = "0xAAa0000000000000000000000000000000000001";
        let resp = state
            .start_game(
                TC,
                "casual",
                None,
                Ladder::Casual,
                [
                    SeatMeta {
                        wallet: Some(addr.into()),
                        ..Default::default()
                    },
                    SeatMeta::default(),
                ],
                [SeatDelivery::Browser, SeatDelivery::Browser],
            )
            .await
            .expect("casual game should start");
        let live = state.0.live_games.lock();
        let g = live.get(&resp.game_id).expect("game is live");
        assert_eq!(g.white.as_deref(), Some(addr));
        assert_eq!(g.black, None);
        // ...and an authed seat is no longer labelled "anonymous".
        assert_eq!(resp.players[0].name, short_addr(addr));
        assert_eq!(resp.players[1].name, "anonymous");
    }

    /// The Test Engine sandbox must not advertise itself in the spectate lobby.
    ///
    /// `/games` is unauthenticated and seats nobody, so its games already record
    /// NULL wallets and never reach a history or an Elo — but they used to be
    /// listed under "Live now" beside real staked tables, which both misreads
    /// the room's activity and lets anyone fill it from a loop. The filter is on
    /// the mode, so this pins BOTH halves: `/games` still records TEST_MODE, and
    /// `live_games` still drops it.
    #[tokio::test]
    async fn a_test_engine_game_is_not_in_the_spectate_lobby() {
        let state = test_state(false, None);
        let test_game = create_game(
            State(state.clone()),
            HeaderMap::new(),
            Json(CreateGameReq {
                initial_secs: 60,
                increment_secs: 0,
            }),
        )
        .await
        .expect("test game should start")
        .0;
        // A park game at the same clock, as the control: whatever hides one must
        // not be hiding the other.
        let park = state
            .start_game(
                TC,
                "park",
                None,
                Ladder::Casual,
                Default::default(),
                [SeatDelivery::Browser, SeatDelivery::Browser],
            )
            .await
            .expect("park game should start");

        {
            let live = state.0.live_games.lock();
            assert_eq!(
                live.get(&test_game.game_id).map(|g| g.mode.as_str()),
                Some(TEST_MODE),
                "/games must record the test mode, or the filter below matches nothing"
            );
            // Both rooms exist; the endpoint's own `started` gate is what keeps
            // either of them out until two seats ready, so mark them started.
            for h in state.0.rooms.lock().values() {
                h.started.store(true, std::sync::atomic::Ordering::Relaxed);
            }
        }

        let listed = live_games(State(state.clone()), HeaderMap::new())
            .await
            .expect("lobby list")
            .0;
        let ids: Vec<_> = listed.iter().map(|g| g.game_id).collect();
        assert!(
            !ids.contains(&test_game.game_id),
            "a Test Engine game reached the spectate lobby"
        );
        assert!(
            ids.contains(&park.game_id),
            "the filter took a real game with it"
        );
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

    /// A sink whose `owner()` can be changed mid-test, standing in for a
    /// completed `Ownable2Step` transfer on the escrow.
    struct TransferableOwner(Mutex<Option<Address>>);

    #[async_trait::async_trait]
    impl ledger::SettlementSink for TransferableOwner {
        async fn open_escrow(
            &self,
            _game_id: Uuid,
            _white: Address,
            _black: Address,
            _stake: U256,
        ) -> anyhow::Result<()> {
            Ok(())
        }
        async fn report_result(
            &self,
            _game_id: Uuid,
            _winner: Option<Address>,
        ) -> anyhow::Result<()> {
            Ok(())
        }
        fn is_onchain(&self) -> bool {
            true
        }
        async fn owner(&self) -> Option<Address> {
            *self.0.lock()
        }
    }

    /// M-04: chain-derived admin authority must FOLLOW the contract's owner.
    ///
    /// The owner was read once at boot and cached for the process lifetime, so
    /// after a completed ownership transfer the server still authorized the old
    /// owner and refused the new one. Revocation did not take — and since the
    /// maintenance switch is DB-persisted, the former owner could keep every
    /// new game blocked across the restarts intended to undo it.
    #[tokio::test]
    async fn admin_authority_follows_an_ownership_transfer() {
        let a: Address = "0xAbC0000000000000000000000000000000000001"
            .parse()
            .unwrap();
        let b: Address = "0xdEF0000000000000000000000000000000000002"
            .parse()
            .unwrap();
        let sink = Arc::new(TransferableOwner(Mutex::new(Some(a))));
        let state = test_state_with_settlement(false, None, sink.clone());

        let tok_a = state.0.auth.mint_session(&format!("{a:?}"));
        let tok_b = state.0.auth.mint_session(&format!("{b:?}"));
        assert!(state.is_admin(&bearer(&tok_a)).await, "A owns the escrow");
        assert!(!state.is_admin(&bearer(&tok_b)).await, "B does not yet");

        // acceptOwnership(): the contract's owner is now B.
        *sink.0.lock() = Some(b);

        assert!(
            !state.is_admin(&bearer(&tok_a)).await,
            "the FORMER owner must lose admin the moment the transfer completes"
        );
        assert!(
            state.is_admin(&bearer(&tok_b)).await,
            "the current owner must gain it"
        );

        // An RPC that stops answering revokes everyone rather than falling
        // back on whoever was cached.
        *sink.0.lock() = None;
        assert!(!state.is_admin(&bearer(&tok_a)).await);
        assert!(!state.is_admin(&bearer(&tok_b)).await);
    }

    /// The other half: an explicitly configured `ADMIN_WALLET` is static by
    /// definition and must not start depending on an RPC call.
    #[tokio::test]
    async fn a_configured_admin_wallet_ignores_the_chain() {
        let configured = "0xAbC0000000000000000000000000000000000001";
        let chain: Address = "0xdEF0000000000000000000000000000000000002"
            .parse()
            .unwrap();
        let sink = Arc::new(TransferableOwner(Mutex::new(Some(chain))));
        let state = test_state_with_settlement(false, Some(configured), sink);

        let tok_cfg = state.0.auth.mint_session(configured);
        let tok_chain = state.0.auth.mint_session(&format!("{chain:?}"));
        assert!(state.is_admin(&bearer(&tok_cfg)).await);
        assert!(
            !state.is_admin(&bearer(&tok_chain)).await,
            "the contract owner is not admin when ADMIN_WALLET names someone else"
        );
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
