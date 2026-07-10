//! Matchmaking for the three game modes, built on `AppState::start_game`.
//!
//! - **Park/Patzer**: post an offer at a price; someone accepts; both get tokens.
//! - **Gauntlet**: join a fixed-tier queue; paired with the next arrival.
//! - **Tournament**: create, players join, start generates round-robin games.
//!
//! For **wagered** games each seat is bound to the wallet that authenticated via
//! SIWE (`Authorization: Bearer`) — never to an address taken from the request
//! body. Casual (unwagered) games need no auth. Lobby state is in-memory with
//! TTL eviction (the Redis layer in production).

use std::collections::{HashMap, VecDeque};
use parking_lot::Mutex;
use std::time::{Duration, Instant};

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use protocol::{Color, GameId};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::mpsc;
use uuid::Uuid;

use ledger::{merkle_proof, tournament_leaf, Address, U256};

use crate::{build_wager, validate_tc, AppState, GameOutcome, MAX_STAKE};

/// Fields larger than this settle via a Merkle root (winners claim individually)
/// instead of a single direct payout transaction.
const ROOT_SETTLE_THRESHOLD: usize = 16;
/// Hard cap on tournament entrants (bounds the O(n^2) round-robin + pool math).
const MAX_TOURNAMENT_PLAYERS: usize = 128;

const OFFER_TTL: Duration = Duration::from_secs(3600);
const TICKET_TTL: Duration = Duration::from_secs(3600);
const TOURNEY_TTL: Duration = Duration::from_secs(24 * 3600);
const GAUNTLET_TTL: Duration = Duration::from_secs(24 * 3600);

#[derive(Default)]
pub struct Lobby {
    park: Mutex<HashMap<Uuid, ParkOffer>>,
    queue: Mutex<HashMap<String, VecDeque<Uuid>>>,
    tickets: Mutex<HashMap<Uuid, Ticket>>,
    tournaments: Mutex<HashMap<Uuid, Tournament>>,
    gauntlets: Mutex<HashMap<Uuid, GauntletSession>>,
    /// game id -> the gauntlet sessions (and the color they played) in it.
    game_to_gauntlet: Mutex<HashMap<GameId, Vec<(Uuid, Color)>>>,
    /// game id -> the tournament it belongs to.
    game_to_tournament: Mutex<HashMap<GameId, Uuid>>,
}

impl Lobby {
    pub fn sweep_expired(&self) {
        self.park.lock().retain(|_, o| o.created_at.elapsed() < OFFER_TTL);
        self.tickets.lock().retain(|_, t| t.created_at.elapsed() < TICKET_TTL);
        self.tournaments.lock().retain(|_, t| t.created_at.elapsed() < TOURNEY_TTL);
        self.gauntlets.lock().retain(|_, g| g.created_at.elapsed() < GAUNTLET_TTL);
    }

    /// Drop game->mode routing entries for games that no longer exist (e.g. a
    /// room that was evicted without emitting a finished outcome). Bounds the
    /// two routing maps so an abandoned game can't leak an entry forever.
    pub fn prune_games(&self, live: &std::collections::HashSet<GameId>) {
        self.game_to_gauntlet.lock().retain(|g, _| live.contains(g));
        self.game_to_tournament.lock().retain(|g, _| live.contains(g));
    }

    /// Update mode standings when a game finishes. Returns a follow-up action
    /// (e.g. a completed tournament that needs settling).
    pub fn record_outcome(&self, game_id: GameId, winner: Option<Color>) -> OutcomeAction {
        // Gauntlet: bump each participating session's W/L/D + game count.
        if let Some(entries) = self.game_to_gauntlet.lock().remove(&game_id) {
            let mut g = self.gauntlets.lock();
            for (sid, color) in entries {
                if let Some(s) = g.get_mut(&sid) {
                    s.games += 1;
                    match winner {
                        None => s.draws += 1,
                        Some(w) if w == color => s.wins += 1,
                        Some(_) => s.losses += 1,
                    }
                }
            }
        }

        // Tournament: award points and, when the last game completes, signal
        // for settlement (handled in `results_task`).
        let mut complete = None;
        if let Some(tid) = self.game_to_tournament.lock().remove(&game_id) {
            let mut tourneys = self.tournaments.lock();
            if let Some(t) = tourneys.get_mut(&tid) {
                if let Some(g) = t.games.iter().find(|g| g.game_id == game_id) {
                    let (w, b) = (g.white.clone(), g.black.clone());
                    match winner {
                        Some(Color::White) => *t.scores.entry(w).or_insert(0.0) += 1.0,
                        Some(Color::Black) => *t.scores.entry(b).or_insert(0.0) += 1.0,
                        None => {
                            *t.scores.entry(w).or_insert(0.0) += 0.5;
                            *t.scores.entry(b).or_insert(0.0) += 0.5;
                        }
                    }
                }
                t.remaining = t.remaining.saturating_sub(1);
                if t.remaining == 0 && t.status == "running" {
                    t.status = "complete".into();
                    complete = Some(tid);
                }
            }
        }
        match complete {
            Some(tid) => OutcomeAction::SettleTournament { tid },
            None => OutcomeAction::None,
        }
    }
}

/// Follow-up work the results dispatcher performs after a game outcome.
pub enum OutcomeAction {
    None,
    SettleTournament { tid: Uuid },
}

/// Consumes game outcomes and updates mode standings; settles finished
/// tournaments on-chain.
pub async fn results_task(state: AppState, mut rx: mpsc::Receiver<GameOutcome>) {
    while let Some(o) = rx.recv().await {
        match state.0.lobby.record_outcome(o.game_id, o.winner) {
            OutcomeAction::None => {}
            OutcomeAction::SettleTournament { tid } => {
                settle_tournament(&state, tid).await;
            }
        }
    }
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/park/offers", post(park_create).get(park_list))
        .route("/park/offers/{id}", get(park_get))
        .route("/park/offers/{id}/accept", post(park_accept))
        .route("/queue", post(queue_join))
        .route("/queue/{id}", get(queue_get))
        .route("/gauntlet/start", post(gauntlet_start))
        .route("/gauntlet/{id}", get(gauntlet_get))
        .route("/gauntlet/{id}/stop", post(gauntlet_stop))
        .route("/tournaments", post(tourney_create).get(tourney_list))
        .route("/tournaments/{id}", get(tourney_get))
        .route("/tournaments/{id}/my-games", get(tourney_my_games))
        .route("/tournaments/{id}/join", post(tourney_join))
        .route("/tournaments/{id}/start", post(tourney_start))
        .route("/tournaments/{id}/claim/{address}", get(tourney_claim_proof))
}

fn di() -> u64 {
    60
}
fn dinc() -> u64 {
    1
}

// --------------------------------------------------------------------------
// Park / Patzer
// --------------------------------------------------------------------------

struct ParkOffer {
    poster_addr: Option<String>, // authenticated wallet (Some only if wagered)
    stake: Option<String>,
    initial_secs: u64,
    increment_secs: u64,
    status: String, // open | matching | matched
    game_id: Option<GameId>,
    poster_token: Option<String>,
    created_at: Instant,
}

#[derive(Deserialize)]
struct ParkCreateReq {
    stake: Option<String>,
    #[serde(default = "di")]
    initial_secs: u64,
    #[serde(default = "dinc")]
    increment_secs: u64,
}

#[derive(Serialize)]
struct ParkCreateResp {
    offer_id: Uuid,
}

async fn park_create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ParkCreateReq>,
) -> Result<Json<ParkCreateResp>, StatusCode> {
    validate_tc(req.initial_secs, req.increment_secs)?;
    // Wagered offers require auth; the poster's seat is their authed wallet.
    let poster_addr = if req.stake.is_some() {
        Some(state.authed_wallet(&headers).ok_or(StatusCode::UNAUTHORIZED)?)
    } else {
        None
    };
    let id = Uuid::new_v4();
    state.0.lobby.park.lock().insert(
        id,
        ParkOffer {
            poster_addr,
            stake: req.stake,
            initial_secs: req.initial_secs,
            increment_secs: req.increment_secs,
            status: "open".into(),
            game_id: None,
            poster_token: None,
            created_at: Instant::now(),
        },
    );
    Ok(Json(ParkCreateResp { offer_id: id }))
}

#[derive(Serialize)]
struct OfferSummary {
    offer_id: Uuid,
    poster_addr: Option<String>,
    stake: Option<String>,
    initial_secs: u64,
    increment_secs: u64,
}

async fn park_list(State(state): State<AppState>) -> Json<Vec<OfferSummary>> {
    let park = state.0.lobby.park.lock();
    Json(
        park.iter()
            .filter(|(_, o)| o.status == "open")
            .map(|(id, o)| OfferSummary {
                offer_id: *id,
                poster_addr: o.poster_addr.clone(),
                stake: o.stake.clone(),
                initial_secs: o.initial_secs,
                increment_secs: o.increment_secs,
            })
            .collect(),
    )
}

#[derive(Serialize)]
struct ParkAcceptResp {
    game_id: GameId,
    token: String,
    color: String,
    spectate_path: String,
}

async fn park_accept(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<ParkAcceptResp>, StatusCode> {
    // Claim the offer (open -> matching), capturing its terms.
    let (poster_addr, stake, initial_secs, increment_secs) = {
        let mut park = state.0.lobby.park.lock();
        let offer = park.get_mut(&id).ok_or(StatusCode::NOT_FOUND)?;
        if offer.status != "open" {
            return Err(StatusCode::CONFLICT);
        }
        offer.status = "matching".into();
        (
            offer.poster_addr.clone(),
            offer.stake.clone(),
            offer.initial_secs,
            offer.increment_secs,
        )
    };

    let unclaim = || {
        if let Some(o) = state.0.lobby.park.lock().get_mut(&id) {
            o.status = "open".into();
        }
    };

    let tc = match validate_tc(initial_secs, increment_secs) {
        Ok(tc) => tc,
        Err(e) => {
            unclaim();
            return Err(e);
        }
    };

    // Build the wager from authenticated wallets (poster + acceptor).
    let wager = if let Some(stake) = stake {
        let acceptor = match state.authed_wallet(&headers) {
            Some(a) => a,
            None => {
                unclaim();
                return Err(StatusCode::UNAUTHORIZED);
            }
        };
        let poster = poster_addr.unwrap_or_default();
        if poster.eq_ignore_ascii_case(&acceptor) {
            unclaim();
            return Err(StatusCode::BAD_REQUEST); // no self-play wagers
        }
        match build_wager(&poster, &acceptor, &stake) {
            Ok(w) => Some(w),
            Err(e) => {
                unclaim();
                return Err(e);
            }
        }
    } else {
        None
    };

    let resp = match state.start_game(tc, "park", wager).await {
        Ok(r) => r,
        Err(e) => {
            unclaim();
            return Err(e);
        }
    };

    if let Some(offer) = state.0.lobby.park.lock().get_mut(&id) {
        offer.status = "matched".into();
        offer.game_id = Some(resp.game_id);
        offer.poster_token = Some(resp.white_token.clone());
    }
    Ok(Json(ParkAcceptResp {
        game_id: resp.game_id,
        token: resp.black_token,
        color: "black".into(),
        spectate_path: resp.spectate_path,
    }))
}

#[derive(Serialize)]
struct ParkGetResp {
    status: String,
    game_id: Option<GameId>,
    token: Option<String>,
    color: Option<String>,
}

async fn park_get(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Json<ParkGetResp> {
    // For a wagered offer, only the authenticated poster may retrieve the white
    // launch token (else anyone polling the id could grab it and throw the
    // staked game). Casual offers carry no stake, so the token is returned freely.
    let park = state.0.lobby.park.lock();
    match park.get(&id) {
        Some(o) => {
            let authorized = match &o.poster_addr {
                Some(addr) => state
                    .authed_wallet(&headers)
                    .map(|w| w.eq_ignore_ascii_case(addr))
                    .unwrap_or(false),
                None => true, // casual offer
            };
            Json(ParkGetResp {
                status: o.status.clone(),
                game_id: o.game_id,
                token: if authorized { o.poster_token.clone() } else { None },
                color: o
                    .poster_token
                    .as_ref()
                    .filter(|_| authorized)
                    .map(|_| "white".into()),
            })
        }
        None => Json(ParkGetResp {
            status: "not_found".into(),
            game_id: None,
            token: None,
            color: None,
        }),
    }
}

// --------------------------------------------------------------------------
// Gauntlet (tier queue)
// --------------------------------------------------------------------------

struct Ticket {
    addr: Option<String>,
    status: String, // waiting | matched
    game_id: Option<GameId>,
    token: Option<String>,
    color: Option<String>,
    /// Gauntlet session this ticket belongs to (for standings), if any.
    session_id: Option<Uuid>,
    created_at: Instant,
}

#[derive(Deserialize)]
struct QueueReq {
    stake: Option<String>,
    #[serde(default = "di")]
    initial_secs: u64,
    #[serde(default = "dinc")]
    increment_secs: u64,
    /// Optional gauntlet session id to attribute the game's result to.
    session_id: Option<Uuid>,
}

#[derive(Serialize)]
struct QueueResp {
    ticket_id: Uuid,
}

async fn queue_join(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<QueueReq>,
) -> Result<Json<QueueResp>, StatusCode> {
    let tc = validate_tc(req.initial_secs, req.increment_secs)?;
    // Wagered tiers require auth; the seat is the authed wallet.
    let addr = if req.stake.is_some() {
        Some(state.authed_wallet(&headers).ok_or(StatusCode::UNAUTHORIZED)?)
    } else {
        None
    };

    // Only a gauntlet session's owner may attribute games to it (prevents
    // stat-poisoning a staked session via a crafted session_id).
    if let Some(sid) = req.session_id {
        let g = state.0.lobby.gauntlets.lock();
        if let Some(s) = g.get(&sid) {
            if let Some(owner) = &s.addr {
                match &addr {
                    Some(a) if a.eq_ignore_ascii_case(owner) => {}
                    _ => return Err(StatusCode::UNAUTHORIZED),
                }
            }
        }
    }

    let key = format!(
        "{}|{}|{}",
        req.stake.clone().unwrap_or_else(|| "0".into()),
        req.initial_secs,
        req.increment_secs
    );
    let my_id = Uuid::new_v4();
    state.0.lobby.tickets.lock().insert(
        my_id,
        Ticket {
            addr: addr.clone(),
            status: "waiting".into(),
            game_id: None,
            token: None,
            color: None,
            session_id: req.session_id,
            created_at: Instant::now(),
        },
    );

    let opponent = {
        let mut queue = state.0.lobby.queue.lock();
        queue.entry(key.clone()).or_default().pop_front()
    };

    if let Some(opp_id) = opponent {
        let (opp_addr, opp_session) = state
            .0
            .lobby
            .tickets
            .lock()
            .get(&opp_id)
            .map(|t| (t.addr.clone(), t.session_id))
            .unwrap_or((None, None));

        // opponent = white, me = black
        let wager = if let Some(stake) = req.stake.clone() {
            let white = opp_addr.clone().ok_or(StatusCode::CONFLICT)?;
            let black = addr.clone().ok_or(StatusCode::UNAUTHORIZED)?;
            if white.eq_ignore_ascii_case(&black) {
                return Err(StatusCode::BAD_REQUEST);
            }
            Some(build_wager(&white, &black, &stake)?)
        } else {
            None
        };

        let resp = state.start_game(tc, "gauntlet", wager).await?;

        // Attribute the game's result to any gauntlet sessions involved.
        let mut links = Vec::new();
        if let Some(sid) = opp_session {
            links.push((sid, Color::White));
        }
        if let Some(sid) = req.session_id {
            links.push((sid, Color::Black));
        }
        if !links.is_empty() {
            state
                .0
                .lobby
                .game_to_gauntlet
                .lock()
                .insert(resp.game_id, links);
        }

        let mut tickets = state.0.lobby.tickets.lock();
        if let Some(t) = tickets.get_mut(&opp_id) {
            t.status = "matched".into();
            t.game_id = Some(resp.game_id);
            t.token = Some(resp.white_token);
            t.color = Some("white".into());
        }
        if let Some(t) = tickets.get_mut(&my_id) {
            t.status = "matched".into();
            t.game_id = Some(resp.game_id);
            t.token = Some(resp.black_token);
            t.color = Some("black".into());
        }
    } else {
        state
            .0
            .lobby
            .queue
            .lock()
            .entry(key)
            .or_default()
            .push_back(my_id);
    }

    Ok(Json(QueueResp { ticket_id: my_id }))
}

#[derive(Serialize)]
struct TicketResp {
    status: String,
    game_id: Option<GameId>,
    token: Option<String>,
    color: Option<String>,
}

async fn queue_get(State(state): State<AppState>, Path(id): Path<Uuid>) -> Json<TicketResp> {
    let tickets = state.0.lobby.tickets.lock();
    match tickets.get(&id) {
        Some(t) => Json(TicketResp {
            status: t.status.clone(),
            game_id: t.game_id,
            token: t.token.clone(),
            color: t.color.clone(),
        }),
        None => Json(TicketResp {
            status: "not_found".into(),
            game_id: None,
            token: None,
            color: None,
        }),
    }
}

// --------------------------------------------------------------------------
// Gauntlet session (accounting + stop control over the tier queue)
// --------------------------------------------------------------------------

struct GauntletSession {
    addr: Option<String>,
    stake: Option<String>,
    initial_secs: u64,
    increment_secs: u64,
    status: String, // running | stopped
    games: u32,
    wins: u32,
    losses: u32,
    draws: u32,
    created_at: Instant,
}

#[derive(Deserialize)]
struct GauntletStartReq {
    stake: Option<String>,
    #[serde(default = "di")]
    initial_secs: u64,
    #[serde(default = "dinc")]
    increment_secs: u64,
}

#[derive(Serialize)]
struct GauntletStartResp {
    session_id: Uuid,
    stake: Option<String>,
    initial_secs: u64,
    increment_secs: u64,
}

async fn gauntlet_start(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<GauntletStartReq>,
) -> Result<Json<GauntletStartResp>, StatusCode> {
    validate_tc(req.initial_secs, req.increment_secs)?;
    let addr = if req.stake.is_some() {
        Some(state.authed_wallet(&headers).ok_or(StatusCode::UNAUTHORIZED)?)
    } else {
        None
    };
    let id = Uuid::new_v4();
    state.0.lobby.gauntlets.lock().insert(
        id,
        GauntletSession {
            addr,
            stake: req.stake.clone(),
            initial_secs: req.initial_secs,
            increment_secs: req.increment_secs,
            status: "running".into(),
            games: 0,
            wins: 0,
            losses: 0,
            draws: 0,
            created_at: Instant::now(),
        },
    );
    Ok(Json(GauntletStartResp {
        session_id: id,
        stake: req.stake,
        initial_secs: req.initial_secs,
        increment_secs: req.increment_secs,
    }))
}

#[derive(Serialize)]
struct GauntletView {
    status: String,
    games: u32,
    wins: u32,
    losses: u32,
    draws: u32,
    stake: Option<String>,
    initial_secs: u64,
    increment_secs: u64,
}

async fn gauntlet_get(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<GauntletView>, StatusCode> {
    let g = state.0.lobby.gauntlets.lock();
    let s = g.get(&id).ok_or(StatusCode::NOT_FOUND)?;
    Ok(Json(GauntletView {
        status: s.status.clone(),
        games: s.games,
        wins: s.wins,
        losses: s.losses,
        draws: s.draws,
        stake: s.stake.clone(),
        initial_secs: s.initial_secs,
        increment_secs: s.increment_secs,
    }))
}

async fn gauntlet_stop(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> StatusCode {
    let mut g = state.0.lobby.gauntlets.lock();
    match g.get_mut(&id) {
        Some(s) => {
            // A staked session can only be stopped by its owner wallet.
            if let Some(addr) = &s.addr {
                match state.authed_wallet(&headers) {
                    Some(w) if w.eq_ignore_ascii_case(addr) => {}
                    _ => return StatusCode::UNAUTHORIZED,
                }
            }
            s.status = "stopped".into();
            StatusCode::OK
        }
        None => StatusCode::NOT_FOUND,
    }
}

// --------------------------------------------------------------------------
// Tournament (round-robin)
// --------------------------------------------------------------------------

struct Tournament {
    name: String,
    buy_in: Option<String>,
    /// The authenticated wallet that created the tournament (if any). Only the
    /// organizer may start it.
    organizer: Option<String>,
    initial_secs: u64,
    increment_secs: u64,
    status: String, // open | running | complete | settled
    players: Vec<String>,
    games: Vec<TourneyGame>,
    scores: HashMap<String, f64>,
    remaining: usize,
    /// For a root-settled (large) tournament: the payout leaves, so the server
    /// can serve Merkle proofs to claimers. (addr, amount in base units)
    payout_leaves: Vec<(String, u128)>,
    created_at: Instant,
}

#[derive(Clone, Serialize)]
struct TourneyGame {
    game_id: GameId,
    white: String,
    black: String,
    // Launch tokens are seat capabilities — never serialize them into the public
    // tournament view. Each entrant fetches only its own via GET
    // /tournaments/{id}/my-games (authenticated). Leaking them lets anyone play
    // (and throw) any game, steering the on-chain pool payout.
    #[serde(skip)]
    white_token: String,
    #[serde(skip)]
    black_token: String,
}

#[derive(Deserialize)]
struct TourneyCreateReq {
    name: String,
    buy_in: Option<String>,
    #[serde(default = "di")]
    initial_secs: u64,
    #[serde(default = "dinc")]
    increment_secs: u64,
}

#[derive(Serialize)]
struct IdResp {
    tournament_id: Uuid,
}

async fn tourney_create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<TourneyCreateReq>,
) -> Result<Json<IdResp>, StatusCode> {
    validate_tc(req.initial_secs, req.increment_secs)?;
    let id = Uuid::new_v4();
    // The creating wallet (if authenticated) — only they may start it later.
    let organizer = state.authed_wallet(&headers);

    // A buy-in tournament opens its on-chain pool now (fail-closed). Require an
    // authenticated caller so an anonymous request can't burn oracle gas.
    if let Some(buy_in_str) = &req.buy_in {
        if state.authed_wallet(&headers).is_none() {
            return Err(StatusCode::UNAUTHORIZED);
        }
        let buy_in = buy_in_str.parse::<U256>().map_err(|_| StatusCode::BAD_REQUEST)?;
        if buy_in == U256::ZERO || buy_in > U256::from(MAX_STAKE) {
            return Err(StatusCode::BAD_REQUEST);
        }
        if !state.0.settlement.is_onchain() {
            return Err(StatusCode::SERVICE_UNAVAILABLE);
        }
        state
            .0
            .settlement
            .open_tournament(id, buy_in)
            .await
            .map_err(|_| StatusCode::BAD_GATEWAY)?;
    }

    let (buy_in, initial_secs, increment_secs) =
        (req.buy_in.clone(), req.initial_secs, req.increment_secs);
    state.0.lobby.tournaments.lock().insert(
        id,
        Tournament {
            name: req.name,
            buy_in: req.buy_in,
            organizer,
            initial_secs: req.initial_secs,
            increment_secs: req.increment_secs,
            status: "open".into(),
            players: Vec::new(),
            games: Vec::new(),
            scores: HashMap::new(),
            remaining: 0,
            payout_leaves: Vec::new(),
            created_at: Instant::now(),
        },
    );
    // Persist so a restart can recover this tournament (see recover_tournaments).
    if let Some(db) = &state.0.db {
        let _ = db
            .upsert_tournament(
                id,
                buy_in.as_deref(),
                initial_secs as i64,
                increment_secs as i64,
                "open",
                &json!([]),
            )
            .await;
    }
    Ok(Json(IdResp { tournament_id: id }))
}

/// Re-persist a tournament's row from its in-memory state (players + status).
async fn persist_tournament(state: &AppState, tid: Uuid) {
    let Some(db) = &state.0.db else { return };
    let snap = {
        let ts = state.0.lobby.tournaments.lock();
        ts.get(&tid).map(|t| {
            (
                t.buy_in.clone(),
                t.initial_secs as i64,
                t.increment_secs as i64,
                t.status.clone(),
                serde_json::to_value(&t.players).unwrap_or_else(|_| json!([])),
            )
        })
    };
    if let Some((buy_in, init, inc, status, players)) = snap {
        let _ = db
            .upsert_tournament(tid, buy_in.as_deref(), init, inc, &status, &players)
            .await;
    }
}

#[derive(Deserialize)]
struct JoinReq {
    /// Display name for a casual tournament (ignored for buy-in tournaments,
    /// where the entrant is the authenticated wallet).
    player: Option<String>,
}

async fn tourney_join(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(req): Json<JoinReq>,
) -> StatusCode {
    // Read the tournament's terms + whether this entrant is already in.
    let (buy_in, status, full) = {
        let t = state.0.lobby.tournaments.lock();
        match t.get(&id) {
            Some(t) => (
                t.buy_in.clone(),
                t.status.clone(),
                t.players.len() >= MAX_TOURNAMENT_PLAYERS,
            ),
            None => return StatusCode::NOT_FOUND,
        }
    };
    if status != "open" {
        return StatusCode::CONFLICT;
    }
    if full {
        return StatusCode::CONFLICT; // entrant cap reached
    }

    // Buy-in tournament: entrant is the authenticated wallet; lock on-chain.
    if let Some(buy_in_str) = buy_in {
        let wallet = match state.authed_wallet(&headers) {
            Some(w) => w,
            None => return StatusCode::UNAUTHORIZED,
        };
        // Already entered? (avoid a duplicate on-chain entry).
        {
            let t = state.0.lobby.tournaments.lock();
            if let Some(t) = t.get(&id) {
                if t.players.iter().any(|p| p.eq_ignore_ascii_case(&wallet)) {
                    return StatusCode::OK;
                }
            }
        }
        let (addr, buy_in) = match (wallet.parse::<Address>(), buy_in_str.parse::<U256>()) {
            (Ok(a), Ok(b)) => (a, b),
            _ => return StatusCode::BAD_REQUEST,
        };
        let _ = buy_in; // amount is enforced on-chain from the tournament record
        if state.0.settlement.enter_tournament(id, addr).await.is_err() {
            return StatusCode::BAD_GATEWAY;
        }
        {
            let mut t = state.0.lobby.tournaments.lock();
            if let Some(t) = t.get_mut(&id) {
                if !t.players.iter().any(|p| p.eq_ignore_ascii_case(&wallet)) {
                    t.players.push(wallet);
                }
            }
        }
        persist_tournament(&state, id).await;
        StatusCode::OK
    } else {
        // Casual tournament: a display name.
        let name = match req.player {
            Some(n) => n,
            None => return StatusCode::BAD_REQUEST,
        };
        {
            let mut t = state.0.lobby.tournaments.lock();
            if let Some(t) = t.get_mut(&id) {
                if !t.players.contains(&name) {
                    t.players.push(name);
                }
            }
        }
        persist_tournament(&state, id).await;
        StatusCode::OK
    }
}

#[derive(Serialize)]
struct TourneyView {
    name: String,
    buy_in: Option<String>,
    status: String,
    players: Vec<String>,
    games: Vec<TourneyGame>,
}

async fn tourney_get(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<TourneyView>, StatusCode> {
    let t = state.0.lobby.tournaments.lock();
    let t = t.get(&id).ok_or(StatusCode::NOT_FOUND)?;
    Ok(Json(TourneyView {
        name: t.name.clone(),
        buy_in: t.buy_in.clone(),
        status: t.status.clone(),
        players: t.players.clone(),
        games: t.games.clone(),
    }))
}

async fn tourney_list(State(state): State<AppState>) -> Json<Vec<IdResp>> {
    let t = state.0.lobby.tournaments.lock();
    Json(t.keys().map(|id| IdResp { tournament_id: *id }).collect())
}

#[derive(Serialize)]
struct MyGame {
    game_id: GameId,
    color: String, // "white" | "black"
    token: String,
    opponent: String,
}

#[derive(Deserialize)]
struct MyGamesQuery {
    /// Casual (no buy-in) tournament display name. Ignored for buy-in
    /// tournaments, where identity is the authenticated wallet.
    player: Option<String>,
}

/// Return only the CALLER's own seat tokens for this tournament, so an entrant
/// can play its games without exposing any other entrant's token (a token is a
/// seat capability — leaking it lets anyone throw the game and steer the pool
/// payout). For a **buy-in** tournament identity is the authenticated wallet
/// (money is at stake, so this is gated). For a **casual** tournament identity
/// is the chosen display name (no money — name-based lookup is fine).
async fn tourney_my_games(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(q): Query<MyGamesQuery>,
    headers: HeaderMap,
) -> Result<Json<Vec<MyGame>>, StatusCode> {
    let t = state.0.lobby.tournaments.lock();
    let t = t.get(&id).ok_or(StatusCode::NOT_FOUND)?;
    let me = if t.buy_in.is_some() {
        state.authed_wallet(&headers).ok_or(StatusCode::UNAUTHORIZED)?
    } else {
        q.player.ok_or(StatusCode::BAD_REQUEST)?
    };
    let mut mine = Vec::new();
    for g in &t.games {
        if g.white.eq_ignore_ascii_case(&me) {
            mine.push(MyGame {
                game_id: g.game_id,
                color: "white".into(),
                token: g.white_token.clone(),
                opponent: g.black.clone(),
            });
        } else if g.black.eq_ignore_ascii_case(&me) {
            mine.push(MyGame {
                game_id: g.game_id,
                color: "black".into(),
                token: g.black_token.clone(),
                opponent: g.white.clone(),
            });
        }
    }
    Ok(Json(mine))
}

/// Start a round-robin: every player pairs with every other once. The games
/// themselves are unwagered — the buy-in *pool* is the money, and game results
/// only decide standings for the on-chain payout. Organizer-authenticated: an
/// anonymous caller must not be able to lock the field before it fills.
async fn tourney_start(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Vec<TourneyGame>>, StatusCode> {
    let caller = state.authed_wallet(&headers);
    let (players, tc) = {
        let mut t = state.0.lobby.tournaments.lock();
        let t = t.get_mut(&id).ok_or(StatusCode::NOT_FOUND)?;
        // Buy-in tournaments (money at stake) may only be started by the
        // organizer — an anonymous caller must not lock the field before it
        // fills. Casual tournaments have no pool, so anyone may start.
        if t.buy_in.is_some() {
            let ok = matches!(
                (&t.organizer, &caller),
                (Some(org), Some(c)) if org.eq_ignore_ascii_case(c)
            );
            if !ok {
                return Err(StatusCode::FORBIDDEN);
            }
        }
        if t.status != "open" || t.players.len() < 2 {
            return Err(StatusCode::CONFLICT);
        }
        t.status = "running".into();
        (
            t.players.clone(),
            validate_tc(t.initial_secs, t.increment_secs)?,
        )
    };

    let mut games = Vec::new();
    for i in 0..players.len() {
        for j in (i + 1)..players.len() {
            let resp = state.start_game(tc, "tournament", None).await?;
            games.push(TourneyGame {
                game_id: resp.game_id,
                white: players[i].clone(),
                black: players[j].clone(),
                white_token: resp.white_token,
                black_token: resp.black_token,
            });
        }
    }

    if let Some(t) = state.0.lobby.tournaments.lock().get_mut(&id) {
        t.games = games.clone();
        t.remaining = games.len();
    }
    // Register each game to the tournament so the results dispatcher can score it.
    {
        let mut map = state.0.lobby.game_to_tournament.lock();
        for g in &games {
            map.insert(g.game_id, id);
        }
    }
    // Persist the running tournament + its pairings so standings can be
    // re-derived after a restart (see recover_tournaments).
    if let Some(db) = &state.0.db {
        let _ = db.set_tournament_status(id, "running").await;
        for g in &games {
            let _ = db.add_tournament_game(id, g.game_id, &g.white, &g.black).await;
        }
    }
    Ok(Json(games))
}

/// Settle a finished tournament: rank all entrants, compute a top-heavy payout
/// split of the pool, and (for a buy-in tournament) distribute on-chain.
async fn settle_tournament(state: &AppState, tid: Uuid) {
    // Snapshot terms + final standings (all entrants, including 0-score).
    let (buy_in, standings) = {
        let tourneys = state.0.lobby.tournaments.lock();
        let Some(t) = tourneys.get(&tid) else {
            return;
        };
        let mut s: Vec<(String, f64)> = t
            .players
            .iter()
            .map(|p| (p.clone(), t.scores.get(p).copied().unwrap_or(0.0)))
            .collect();
        s.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        (t.buy_in.clone(), s)
    };
    tracing::info!(tournament = %tid, ?standings, "tournament complete — final standings");

    if let Some(buy_in_str) = buy_in {
        if let Err(e) = distribute_pool(state, tid, &buy_in_str, &standings).await {
            tracing::error!(tournament = %tid, "tournament settlement failed: {e:#}");
            // leave status 'complete' so it can be retried / inspected
            return;
        }
    }
    if let Some(t) = state.0.lobby.tournaments.lock().get_mut(&tid) {
        t.status = "settled".into();
    }
    if let Some(db) = &state.0.db {
        let _ = db.set_tournament_status(tid, "settled").await;
    }
}

/// Recover tournaments after a restart. A `running` tournament whose games all
/// finished is settled by result; one with games still in flight is marked
/// `abandoned` (their rooms are gone) — entrants recover via on-chain
/// `claimRefund` after the timeout.
pub async fn recover_tournaments(state: &AppState) {
    let Some(db) = &state.0.db else { return };
    let rows = match db.recoverable_tournaments().await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("tournament recovery query failed: {e:#}");
            return;
        }
    };
    for t in rows {
        let games = db.tournament_game_results(t.id).await.unwrap_or_default();
        if games.is_empty() {
            continue;
        }
        let unfinished = games
            .iter()
            .filter(|g| g.game_status.as_deref() != Some("finished"))
            .count();
        let players: Vec<String> = serde_json::from_value(t.players.clone()).unwrap_or_default();

        if unfinished == 0 {
            // Re-derive standings from persisted game results, then settle.
            let mut scores: HashMap<String, f64> = HashMap::new();
            for g in &games {
                match g.game_result.as_deref() {
                    Some("white") => *scores.entry(g.white.clone()).or_insert(0.0) += 1.0,
                    Some("black") => *scores.entry(g.black.clone()).or_insert(0.0) += 1.0,
                    Some("draw") => {
                        *scores.entry(g.white.clone()).or_insert(0.0) += 0.5;
                        *scores.entry(g.black.clone()).or_insert(0.0) += 0.5;
                    }
                    _ => {}
                }
            }
            state.0.lobby.tournaments.lock().insert(
                t.id,
                Tournament {
                    name: "recovered".into(),
                    buy_in: t.buy_in.clone(),
                    organizer: None, // recovered tournaments are already past 'open'
                    initial_secs: 0,
                    increment_secs: 0,
                    status: "complete".into(),
                    players,
                    games: Vec::new(),
                    scores,
                    remaining: 0,
                    payout_leaves: Vec::new(),
                    created_at: Instant::now(),
                },
            );
            tracing::info!(tournament = %t.id, "recovered completed tournament — settling by result");
            settle_tournament(state, t.id).await;
        } else {
            tracing::warn!(
                tournament = %t.id, unfinished,
                "tournament interrupted by restart — marking abandoned; entrants refund via claimRefund"
            );
            let _ = db.set_tournament_status(t.id, "abandoned").await;
        }
    }
}

/// Top-heavy payout weights (basis points) by field size.
fn payout_weights(n: usize) -> Vec<u128> {
    match n {
        0 => vec![],
        1 => vec![10_000],
        2 => vec![7_000, 3_000],
        _ => {
            let mut w = vec![6_500, 2_500, 1_000];
            w.resize(n, 0);
            w
        }
    }
}

async fn distribute_pool(
    state: &AppState,
    tid: Uuid,
    buy_in_str: &str,
    standings: &[(String, f64)],
) -> anyhow::Result<()> {
    let n = standings.len();
    let buy_in = buy_in_str
        .parse::<U256>()
        .map_err(|_| anyhow::anyhow!("bad buy-in"))?
        .to::<u128>();
    let pool = buy_in
        .checked_mul(n as u128)
        .ok_or_else(|| anyhow::anyhow!("pool overflow"))?;

    // Payout per standings rank; remainder (rounding) goes to the winner.
    let weights = payout_weights(n);
    let mut by_rank = vec![0u128; n];
    let mut assigned = 0u128;
    for i in 0..n {
        by_rank[i] = pool
            .checked_mul(weights[i])
            .ok_or_else(|| anyhow::anyhow!("payout overflow"))?
            / 10_000;
        assigned += by_rank[i];
    }
    if n > 0 {
        by_rank[0] += pool - assigned; // full pool distributed (0 rake)
    }

    // Map payouts back to the entrant (players) order the contract expects.
    use std::collections::HashMap;
    let payout_for: HashMap<&str, u128> = standings
        .iter()
        .enumerate()
        .map(|(i, (p, _))| (p.as_str(), by_rank[i]))
        .collect();

    let mut addrs = Vec::with_capacity(n);
    let mut payouts = Vec::with_capacity(n);
    for (player, _) in standings {
        let addr = player
            .parse::<Address>()
            .map_err(|_| anyhow::anyhow!("entrant {player} is not an address"))?;
        addrs.push(addr);
        payouts.push(U256::from(*payout_for.get(player.as_str()).unwrap_or(&0)));
    }

    // Large fields settle via a Merkle root (O(1) per winner claim); small
    // fields settle directly. Settlement is enqueued to a DURABLE outbox (a
    // worker drains it on-chain, with retry); with no DB we settle inline.
    if n > ROOT_SETTLE_THRESHOLD {
        // Only winners (amount > 0) become leaves; losers already paid at entry.
        let leaves: Vec<(Address, U256)> = addrs
            .iter()
            .zip(payouts.iter())
            .filter(|(_, p)| **p > U256::ZERO)
            .map(|(a, p)| (*a, *p))
            .collect();
        // Persist leaves in memory so the server can serve claim proofs.
        if let Some(t) = state.0.lobby.tournaments.lock().get_mut(&tid) {
            t.payout_leaves = leaves
                .iter()
                .map(|(a, p)| (format!("{a:?}"), p.to::<u128>()))
                .collect();
        }
        match &state.0.db {
            Some(db) => {
                let payload = json!({
                    "leaves": leaves.iter()
                        .map(|(a, p)| [format!("{a:?}"), p.to_string()])
                        .collect::<Vec<_>>()
                });
                db.enqueue_tournament_settlement(tid, "root", payload).await?;
                Ok(())
            }
            None => state.0.settlement.settle_tournament_root(tid, leaves).await.map(|_| ()),
        }
    } else {
        match &state.0.db {
            Some(db) => {
                let payload = json!({
                    "winners": addrs.iter().map(|a| format!("{a:?}")).collect::<Vec<_>>(),
                    "payouts": payouts.iter().map(|p| p.to_string()).collect::<Vec<_>>(),
                });
                db.enqueue_tournament_settlement(tid, "direct", payload).await?;
                Ok(())
            }
            None => state.0.settlement.settle_tournament(tid, addrs, payouts).await,
        }
    }
}

#[derive(Serialize)]
struct ClaimProof {
    amount: String,
    proof: Vec<String>,
}

/// Parse `{ "leaves": [[addr, amount], ...] }` (durable outbox payload).
fn parse_leaves(v: &serde_json::Value) -> Vec<(String, u128)> {
    v.get("leaves")
        .and_then(|l| l.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|pair| {
                    let a = pair.get(0)?.as_str()?.to_string();
                    let amt = pair.get(1)?.as_str()?.parse::<u128>().ok()?;
                    Some((a, amt))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Serve a Merkle proof for a winner to claim from a root-settled tournament.
async fn tourney_claim_proof(
    State(state): State<AppState>,
    Path((id, address)): Path<(Uuid, String)>,
) -> Result<Json<ClaimProof>, StatusCode> {
    // Prefer in-memory leaves; fall back to the durable outbox payload so
    // proofs survive a server restart.
    let mem = {
        let t = state.0.lobby.tournaments.lock();
        t.get(&id).map(|t| t.payout_leaves.clone()).unwrap_or_default()
    };
    let leaves = if !mem.is_empty() {
        mem
    } else if let Some(db) = &state.0.db {
        match db.tournament_payload(id).await {
            Ok(Some(v)) => parse_leaves(&v),
            _ => Vec::new(),
        }
    } else {
        Vec::new()
    };
    if leaves.is_empty() {
        return Err(StatusCode::NOT_FOUND); // not a root-settled tournament
    }
    let idx = leaves
        .iter()
        .position(|(a, _)| a.eq_ignore_ascii_case(&address))
        .ok_or(StatusCode::NOT_FOUND)?;
    let amount = leaves[idx].1;
    let hashes: Vec<_> = leaves
        .iter()
        .filter_map(|(a, amt)| a.parse::<Address>().ok().map(|a| tournament_leaf(a, U256::from(*amt))))
        .collect();
    if hashes.len() != leaves.len() {
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }
    let proof = merkle_proof(&hashes, idx);
    Ok(Json(ClaimProof {
        amount: amount.to_string(),
        proof: proof.iter().map(|p| format!("{p:#x}")).collect(),
    }))
}
