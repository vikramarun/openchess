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
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use protocol::GameId;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{build_wager, validate_tc, AppState};

const OFFER_TTL: Duration = Duration::from_secs(3600);
const TICKET_TTL: Duration = Duration::from_secs(3600);
const TOURNEY_TTL: Duration = Duration::from_secs(24 * 3600);

#[derive(Default)]
pub struct Lobby {
    park: Mutex<HashMap<Uuid, ParkOffer>>,
    queue: Mutex<HashMap<String, VecDeque<Uuid>>>,
    tickets: Mutex<HashMap<Uuid, Ticket>>,
    tournaments: Mutex<HashMap<Uuid, Tournament>>,
}

impl Lobby {
    pub fn sweep_expired(&self) {
        self.park.lock().unwrap().retain(|_, o| o.created_at.elapsed() < OFFER_TTL);
        self.tickets.lock().unwrap().retain(|_, t| t.created_at.elapsed() < TICKET_TTL);
        self.tournaments.lock().unwrap().retain(|_, t| t.created_at.elapsed() < TOURNEY_TTL);
    }
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/park/offers", post(park_create).get(park_list))
        .route("/park/offers/{id}", get(park_get))
        .route("/park/offers/{id}/accept", post(park_accept))
        .route("/queue", post(queue_join))
        .route("/queue/{id}", get(queue_get))
        .route("/tournaments", post(tourney_create).get(tourney_list))
        .route("/tournaments/{id}", get(tourney_get))
        .route("/tournaments/{id}/join", post(tourney_join))
        .route("/tournaments/{id}/start", post(tourney_start))
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
    state.0.lobby.park.lock().unwrap().insert(
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
    let park = state.0.lobby.park.lock().unwrap();
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
        let mut park = state.0.lobby.park.lock().unwrap();
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
        if let Some(o) = state.0.lobby.park.lock().unwrap().get_mut(&id) {
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

    if let Some(offer) = state.0.lobby.park.lock().unwrap().get_mut(&id) {
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

async fn park_get(State(state): State<AppState>, Path(id): Path<Uuid>) -> Json<ParkGetResp> {
    let park = state.0.lobby.park.lock().unwrap();
    match park.get(&id) {
        Some(o) => Json(ParkGetResp {
            status: o.status.clone(),
            game_id: o.game_id,
            token: o.poster_token.clone(),
            color: o.poster_token.as_ref().map(|_| "white".into()),
        }),
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
    created_at: Instant,
}

#[derive(Deserialize)]
struct QueueReq {
    stake: Option<String>,
    #[serde(default = "di")]
    initial_secs: u64,
    #[serde(default = "dinc")]
    increment_secs: u64,
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

    let key = format!(
        "{}|{}|{}",
        req.stake.clone().unwrap_or_else(|| "0".into()),
        req.initial_secs,
        req.increment_secs
    );
    let my_id = Uuid::new_v4();
    state.0.lobby.tickets.lock().unwrap().insert(
        my_id,
        Ticket {
            addr: addr.clone(),
            status: "waiting".into(),
            game_id: None,
            token: None,
            color: None,
            created_at: Instant::now(),
        },
    );

    let opponent = {
        let mut queue = state.0.lobby.queue.lock().unwrap();
        queue.entry(key.clone()).or_default().pop_front()
    };

    if let Some(opp_id) = opponent {
        let opp_addr = state
            .0
            .lobby
            .tickets
            .lock()
            .unwrap()
            .get(&opp_id)
            .and_then(|t| t.addr.clone());

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

        let mut tickets = state.0.lobby.tickets.lock().unwrap();
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
            .unwrap()
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
    let tickets = state.0.lobby.tickets.lock().unwrap();
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
// Tournament (round-robin)
// --------------------------------------------------------------------------

struct Tournament {
    name: String,
    buy_in: Option<String>,
    initial_secs: u64,
    increment_secs: u64,
    status: String, // open | running
    players: Vec<String>,
    games: Vec<TourneyGame>,
    created_at: Instant,
}

#[derive(Clone, Serialize)]
struct TourneyGame {
    game_id: GameId,
    white: String,
    black: String,
    white_token: String,
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
    Json(req): Json<TourneyCreateReq>,
) -> Result<Json<IdResp>, StatusCode> {
    validate_tc(req.initial_secs, req.increment_secs)?;
    let id = Uuid::new_v4();
    state.0.lobby.tournaments.lock().unwrap().insert(
        id,
        Tournament {
            name: req.name,
            buy_in: req.buy_in,
            initial_secs: req.initial_secs,
            increment_secs: req.increment_secs,
            status: "open".into(),
            players: Vec::new(),
            games: Vec::new(),
            created_at: Instant::now(),
        },
    );
    Ok(Json(IdResp { tournament_id: id }))
}

#[derive(Deserialize)]
struct JoinReq {
    player: String,
}

async fn tourney_join(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(req): Json<JoinReq>,
) -> StatusCode {
    let mut t = state.0.lobby.tournaments.lock().unwrap();
    match t.get_mut(&id) {
        Some(t) if t.status == "open" => {
            if !t.players.contains(&req.player) {
                t.players.push(req.player);
            }
            StatusCode::OK
        }
        Some(_) => StatusCode::CONFLICT,
        None => StatusCode::NOT_FOUND,
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
    let t = state.0.lobby.tournaments.lock().unwrap();
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
    let t = state.0.lobby.tournaments.lock().unwrap();
    Json(t.keys().map(|id| IdResp { tournament_id: *id }).collect())
}

/// Start a round-robin: every player pairs with every other once. Games are
/// created **unwagered** for now (pool prize distribution needs a dedicated
/// contract method and is not yet wired — tracked in AUDIT.md / README).
async fn tourney_start(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<TourneyGame>>, StatusCode> {
    let (players, tc) = {
        let mut t = state.0.lobby.tournaments.lock().unwrap();
        let t = t.get_mut(&id).ok_or(StatusCode::NOT_FOUND)?;
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

    if let Some(t) = state.0.lobby.tournaments.lock().unwrap().get_mut(&id) {
        t.games = games.clone();
    }
    Ok(Json(games))
}
