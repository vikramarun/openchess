//! Matchmaking for the three game modes, built on `AppState::start_game`.
//!
//! - **Park/Patzer**: post an offer at a price; someone accepts; both get tokens.
//! - **Gauntlet**: join a fixed-tier queue; paired with the next arrival; the
//!   client re-queues after each game to "keep playing until you stop".
//! - **Tournament**: create, players join, start generates round-robin games.
//!
//! Lobby state is in-memory (the Redis layer in production). Durable game data
//! is persisted by `start_game` + the room.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use protocol::{GameId, TimeControl};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{parse_wager, AppState};

#[derive(Default)]
pub struct Lobby {
    park: Mutex<HashMap<Uuid, ParkOffer>>,
    /// tier key -> waiting ticket ids
    queue: Mutex<HashMap<String, VecDeque<Uuid>>>,
    tickets: Mutex<HashMap<Uuid, Ticket>>,
    tournaments: Mutex<HashMap<Uuid, Tournament>>,
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

fn tc_of(initial_secs: u64, increment_secs: u64) -> TimeControl {
    TimeControl {
        initial_ms: initial_secs * 1_000,
        increment_ms: increment_secs * 1_000,
    }
}

// --------------------------------------------------------------------------
// Park / Patzer
// --------------------------------------------------------------------------

struct ParkOffer {
    poster_addr: Option<String>,
    stake: Option<String>,
    initial_secs: u64,
    increment_secs: u64,
    status: String, // open | matching | matched
    game_id: Option<GameId>,
    poster_token: Option<String>,
}

#[derive(Deserialize)]
struct ParkCreateReq {
    poster_addr: Option<String>,
    stake: Option<String>,
    #[serde(default = "di")]
    initial_secs: u64,
    #[serde(default = "dinc")]
    increment_secs: u64,
}
fn di() -> u64 {
    60
}
fn dinc() -> u64 {
    1
}

#[derive(Serialize)]
struct ParkCreateResp {
    offer_id: Uuid,
}

async fn park_create(
    State(state): State<AppState>,
    Json(req): Json<ParkCreateReq>,
) -> Json<ParkCreateResp> {
    let id = Uuid::new_v4();
    state.0.lobby.park.lock().unwrap().insert(
        id,
        ParkOffer {
            poster_addr: req.poster_addr,
            stake: req.stake,
            initial_secs: req.initial_secs,
            increment_secs: req.increment_secs,
            status: "open".into(),
            game_id: None,
            poster_token: None,
        },
    );
    Json(ParkCreateResp { offer_id: id })
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
    let open = park
        .iter()
        .filter(|(_, o)| o.status == "open")
        .map(|(id, o)| OfferSummary {
            offer_id: *id,
            poster_addr: o.poster_addr.clone(),
            stake: o.stake.clone(),
            initial_secs: o.initial_secs,
            increment_secs: o.increment_secs,
        })
        .collect();
    Json(open)
}

#[derive(Deserialize)]
struct ParkAcceptReq {
    acceptor_addr: Option<String>,
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
    Json(req): Json<ParkAcceptReq>,
) -> Result<Json<ParkAcceptResp>, axum::http::StatusCode> {
    // Claim the offer (open -> matching) under lock, capturing its terms.
    let (poster_addr, stake, tc) = {
        let mut park = state.0.lobby.park.lock().unwrap();
        let offer = park.get_mut(&id).ok_or(axum::http::StatusCode::NOT_FOUND)?;
        if offer.status != "open" {
            return Err(axum::http::StatusCode::CONFLICT);
        }
        offer.status = "matching".into();
        (
            offer.poster_addr.clone(),
            offer.stake.clone(),
            tc_of(offer.initial_secs, offer.increment_secs),
        )
    };

    let wager = parse_wager(&poster_addr, &req.acceptor_addr, &stake);
    let resp = state.start_game(tc, "park", wager).await;

    let mut park = state.0.lobby.park.lock().unwrap();
    if let Some(offer) = park.get_mut(&id) {
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
    /// The poster's launch token, once matched (color = white).
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
    stake: Option<String>,
    status: String, // waiting | matched
    game_id: Option<GameId>,
    token: Option<String>,
    color: Option<String>,
}

#[derive(Deserialize)]
struct QueueReq {
    addr: Option<String>,
    /// Stake tier in USDC base units (the Gauntlet tier).
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

async fn queue_join(State(state): State<AppState>, Json(req): Json<QueueReq>) -> Json<QueueResp> {
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
            addr: req.addr.clone(),
            stake: req.stake.clone(),
            status: "waiting".into(),
            game_id: None,
            token: None,
            color: None,
        },
    );

    // Try to pair with a waiting opponent at the same tier.
    let opponent = {
        let mut queue = state.0.lobby.queue.lock().unwrap();
        let waiting = queue.entry(key.clone()).or_default();
        waiting.pop_front()
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
        let wager = parse_wager(&opp_addr, &req.addr, &req.stake);
        let resp = state
            .start_game(tc_of(req.initial_secs, req.increment_secs), "gauntlet", wager)
            .await;

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

    Json(QueueResp { ticket_id: my_id })
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
) -> Json<IdResp> {
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
        },
    );
    Json(IdResp { tournament_id: id })
}

#[derive(Deserialize)]
struct JoinReq {
    player: String,
}

async fn tourney_join(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(req): Json<JoinReq>,
) -> axum::http::StatusCode {
    let mut t = state.0.lobby.tournaments.lock().unwrap();
    match t.get_mut(&id) {
        Some(t) if t.status == "open" => {
            if !t.players.contains(&req.player) {
                t.players.push(req.player);
            }
            axum::http::StatusCode::OK
        }
        Some(_) => axum::http::StatusCode::CONFLICT,
        None => axum::http::StatusCode::NOT_FOUND,
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
) -> Result<Json<TourneyView>, axum::http::StatusCode> {
    let t = state.0.lobby.tournaments.lock().unwrap();
    let t = t.get(&id).ok_or(axum::http::StatusCode::NOT_FOUND)?;
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
/// created (unwagered for now; pool prize distribution needs a dedicated
/// contract method and is not yet wired).
async fn tourney_start(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<TourneyGame>>, axum::http::StatusCode> {
    let (players, tc) = {
        let mut t = state.0.lobby.tournaments.lock().unwrap();
        let t = t.get_mut(&id).ok_or(axum::http::StatusCode::NOT_FOUND)?;
        if t.status != "open" || t.players.len() < 2 {
            return Err(axum::http::StatusCode::CONFLICT);
        }
        t.status = "running".into();
        (t.players.clone(), tc_of(t.initial_secs, t.increment_secs))
    };

    let mut games = Vec::new();
    for i in 0..players.len() {
        for j in (i + 1)..players.len() {
            let resp = state.start_game(tc, "tournament", None).await;
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
