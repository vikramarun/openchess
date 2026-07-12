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

use parking_lot::Mutex;
use std::collections::{HashMap, VecDeque};
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

use crate::agents::AgentUnavailable;
use crate::ratelimit::client_ip;
use crate::{
    build_wager, sanitize_label, short_addr, validate_tc, AppState, GameOutcome, SeatDelivery,
    SeatMeta, MAX_STAKE,
};

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
        self.park
            .lock()
            .retain(|_, o| o.created_at.elapsed() < OFFER_TTL);
        self.tickets
            .lock()
            .retain(|_, t| t.created_at.elapsed() < TICKET_TTL);
        self.tournaments
            .lock()
            .retain(|_, t| t.created_at.elapsed() < TOURNEY_TTL);
        self.gauntlets
            .lock()
            .retain(|_, g| g.created_at.elapsed() < GAUNTLET_TTL);
    }

    /// Drop game->mode routing entries for games that no longer exist (e.g. a
    /// room that was evicted without emitting a finished outcome). Bounds the
    /// two routing maps so an abandoned game can't leak an entry forever.
    pub fn prune_games(&self, live: &std::collections::HashSet<GameId>) {
        self.game_to_gauntlet.lock().retain(|g, _| live.contains(g));
        self.game_to_tournament
            .lock()
            .retain(|g, _| live.contains(g));
    }

    /// Update mode standings when a game finishes. Returns a follow-up action
    /// (e.g. a completed tournament that needs settling).
    pub fn record_outcome(&self, o: &GameOutcome) -> OutcomeAction {
        let GameOutcome { game_id, winner, plies, white_showed_up, black_showed_up } = *o;
        // Gauntlet: bump each participating session's W/L/D + game count.
        if let Some(entries) = self.game_to_gauntlet.lock().remove(&game_id) {
            let mut g = self.gauntlets.lock();
            for (sid, color) in entries {
                let showed_up = match color {
                    Color::White => white_showed_up,
                    Color::Black => black_showed_up,
                };
                if let Some(s) = g.get_mut(&sid) {
                    s.games += 1;
                    match winner {
                        None => {
                            s.draws += 1;
                            // A never-started reap that drew (plies == 0): stop
                            // this session only if ITS OWN seat never readied (a
                            // dead/hung-at-init engine). If we readied and the
                            // OPPONENT was the no-show, we're fine — keep running.
                            // A real drawn game has plies > 0 and never stops.
                            if plies == 0 && !showed_up {
                                s.status = "stopped".into();
                            }
                        }
                        Some(w) if w == color => s.wins += 1,
                        Some(_) => {
                            s.losses += 1;
                            // Protect a staked gauntlet from an engine that LOST
                            // without ever making a move (offline, or hung during
                            // init — a no-show forfeit): auto-stop so it doesn't
                            // bleed the stake game after game. NOTE: this only
                            // catches a ZERO-move loss; an engine that plays a move
                            // and THEN hangs still loses on time each game and is
                            // not stopped here (that would need a consecutive-loss
                            // heuristic). White's first move is ply 1, Black's is
                            // ply 2, so the seat actually played iff:
                            let played = match color {
                                Color::White => plies >= 1,
                                Color::Black => plies >= 2,
                            };
                            if !played {
                                s.status = "stopped".into();
                            }
                        }
                    }
                }
            }
        }

        // Tournament: award points for the finished game; when the current
        // round's games are all done, signal to advance (dispatch the next round
        // or settle) — handled in `results_task` since dispatch is async.
        let mut action = OutcomeAction::None;
        if let Some(tid) = self.game_to_tournament.lock().remove(&game_id) {
            let mut tourneys = self.tournaments.lock();
            if let Some(t) = tourneys.get_mut(&tid) {
                if let Some(g) = t.games.iter().find(|g| g.game_id == game_id) {
                    let (w, b) = (g.white.clone(), g.black.clone());
                    score_pair(&mut t.scores, &w, &b, winner);
                }
                if t.status == "running" {
                    t.round_remaining = t.round_remaining.saturating_sub(1);
                    if t.round_remaining == 0 {
                        t.current_round += 1; // move to the next round to dispatch
                        action = OutcomeAction::AdvanceTournament { tid };
                    }
                }
            }
        }
        action
    }
}

/// Follow-up work the results dispatcher performs after a game outcome.
pub enum OutcomeAction {
    None,
    /// The current tournament round finished; dispatch the next one (or settle
    /// if the schedule is exhausted).
    AdvanceTournament { tid: Uuid },
}

/// Consumes game outcomes and updates mode standings; drives tournament rounds
/// and settles finished tournaments on-chain.
pub async fn results_task(state: AppState, mut rx: mpsc::Receiver<GameOutcome>) {
    while let Some(o) = rx.recv().await {
        // Free any bots seated in the finished game NOW, deterministically, before
        // a tournament round-advance re-claims them for the next round. The room
        // sends this outcome BEFORE it sends cleanup_tx, so relying on
        // cleanup_task's game_ended would race the re-claim and the bots would
        // spuriously forfeit. game_ended is idempotent, so cleanup_task's later
        // call is a harmless no-op. (Also fixes a gauntlet rapid-re-queue 409.)
        state.0.agents.game_ended(o.game_id);
        match state.0.lobby.record_outcome(&o) {
            OutcomeAction::None => {}
            OutcomeAction::AdvanceTournament { tid } => {
                dispatch_from_current(&state, tid).await;
            }
        }
    }
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/park/offers", post(park_create).get(park_list))
        .route("/park/offers/{id}", get(park_get).delete(park_cancel))
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
        .route(
            "/tournaments/{id}/claim/{address}",
            get(tourney_claim_proof),
        )
}

fn di() -> u64 {
    60
}
fn dinc() -> u64 {
    1
}

// --------------------------------------------------------------------------
// Bot seats (played by the user's connected agent, driven from the web)
// --------------------------------------------------------------------------

fn is_bot_seat(seat: &Option<String>) -> bool {
    seat.as_deref() == Some("bot")
}

/// Sanitize user-supplied UCI option overrides before relaying them to the
/// user's own agent (bounded count + label-cleaned keys/values).
fn clean_uci_options(opts: Option<HashMap<String, String>>) -> Vec<(String, String)> {
    opts.unwrap_or_default()
        .into_iter()
        .filter_map(|(k, v)| Some((sanitize_label(&k)?, sanitize_label(&v)?)))
        .take(32)
        .collect()
}

/// Claim the wallet's agent for a bot seat: on success returns the
/// `SeatDelivery::Agent` and records the claimed wallet in `claimed` (so a later
/// failure can release exactly the agents this game claimed); on failure returns
/// the `AgentUnavailable` for the caller to map to its own recovery. Every mode
/// (park / gauntlet / tournament) claims bot seats through this one path, so the
/// claim/release accounting stays consistent. Non-bot seats use
/// `SeatDelivery::Browser` directly and never call this.
fn claim_agent_seat(
    agents: &crate::agents::Agents,
    wallet: String,
    uci_options: Vec<(String, String)>,
    claimed: &mut Vec<String>,
) -> Result<SeatDelivery, AgentUnavailable> {
    let tx = agents.claim(&wallet)?;
    claimed.push(wallet.clone());
    Ok(SeatDelivery::Agent {
        wallet,
        tx,
        uci_options,
    })
}

// Seat dispatch itself lives in `AppState::start_game` (a `SeatDelivery` per
// seat), so every mode shares one claim/dispatch/rollback implementation.

// --------------------------------------------------------------------------
// Park / Patzer
// --------------------------------------------------------------------------

struct ParkOffer {
    poster_addr: Option<String>, // authenticated wallet (wagered or bot seats)
    poster_name: Option<String>, // self-declared display name (sanitized)
    poster_engine: Option<String>, // self-declared engine (sanitized)
    /// The poster's seat is played by their connected agent, not a browser.
    poster_seat_bot: bool,
    /// UCI option overrides for the poster's bot (relayed on dispatch).
    poster_uci_options: Vec<(String, String)>,
    stake: Option<String>,
    initial_secs: u64,
    increment_secs: u64,
    status: String, // open | matching | matched
    game_id: Option<GameId>,
    poster_token: Option<String>,
    /// Capability to cancel this offer, returned only to its creator.
    cancel_key: String,
    /// Who this offer counts against for the open-offer cap: the poster's
    /// wallet (lowercased) when known, else `ip:<client-ip>` for anonymous
    /// casual offers. Not exposed to clients.
    owner_key: String,
    created_at: Instant,
}

#[derive(Deserialize)]
struct ParkCreateReq {
    stake: Option<String>,
    #[serde(default = "di")]
    initial_secs: u64,
    #[serde(default = "dinc")]
    increment_secs: u64,
    /// Optional self-declared display name (shown in the lobby).
    name: Option<String>,
    /// Optional self-declared engine name (shown in the lobby; unverified).
    engine: Option<String>,
    /// "bot" seats the poster's connected agent; anything else = browser.
    seat: Option<String>,
    /// UCI option overrides for a bot seat (applied by the agent per game).
    uci_options: Option<HashMap<String, String>>,
}

#[derive(Serialize)]
struct ParkCreateResp {
    offer_id: Uuid,
    /// Present this to DELETE /park/offers/{id} to withdraw the offer.
    cancel_key: String,
}

async fn park_create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ParkCreateReq>,
) -> Result<Json<ParkCreateResp>, StatusCode> {
    // Drain: no point posting an offer nobody can accept while paused.
    state.reject_if_draining()?;
    validate_tc(req.initial_secs, req.increment_secs)?;
    // Throttle offer creation per-IP (cheap to spam, seeds the public lobby).
    let ip = client_ip(&headers);
    if state.0.limits.offers.check(&ip).is_some() {
        return Err(StatusCode::TOO_MANY_REQUESTS);
    }
    let bot = is_bot_seat(&req.seat);
    // Wagered offers AND bot seats require auth: the seat (and the agent it
    // dispatches to) is always the authed wallet's. For casual offers the
    // wallet is recorded when known — clients rely on `poster_addr` to avoid
    // accepting their own offers (e.g. a restarted autopilot vs its stale
    // offer), so an authed poster must never appear anonymous.
    let poster_addr = if req.stake.is_some() || bot {
        Some(
            state
                .authed_wallet(&headers)
                .ok_or(StatusCode::UNAUTHORIZED)?,
        )
    } else {
        state.authed_wallet(&headers)
    };

    let mut poster_name = req.name.as_deref().and_then(sanitize_label);
    let mut poster_engine = req.engine.as_deref().and_then(sanitize_label);
    if bot {
        // The bot must be online to post as it; default identity from its
        // registration so the lobby shows what it actually runs.
        let wallet = poster_addr.as_deref().unwrap_or_default();
        let Some((meta, _busy)) = state.0.agents.view(wallet) else {
            return Err(StatusCode::FAILED_DEPENDENCY); // 424: bot offline
        };
        poster_name = poster_name.or(Some(meta.name));
        poster_engine = poster_engine.or(Some(meta.engine));
    }

    // Cap simultaneously-open offers per owner (wallet if known, else IP) so a
    // single actor can't flood the lobby with challenges.
    let owner_key = poster_addr
        .clone()
        .unwrap_or_else(|| format!("ip:{ip}"));
    let id = Uuid::new_v4();
    let cancel_key = Uuid::new_v4().simple().to_string();
    {
        let mut park = state.0.lobby.park.lock();
        let open = park
            .values()
            .filter(|o| o.owner_key == owner_key && o.status != "matched")
            .count();
        if open >= state.0.limits.max_open_offers {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        park.insert(
            id,
            ParkOffer {
                poster_addr,
                poster_name,
                poster_engine,
                poster_seat_bot: bot,
                poster_uci_options: clean_uci_options(req.uci_options),
                stake: req.stake,
                initial_secs: req.initial_secs,
                increment_secs: req.increment_secs,
                status: "open".into(),
                game_id: None,
                poster_token: None,
                cancel_key: cancel_key.clone(),
                owner_key,
                created_at: Instant::now(),
            },
        );
    }
    Ok(Json(ParkCreateResp {
        offer_id: id,
        cancel_key,
    }))
}

#[derive(Deserialize)]
struct CancelQuery {
    key: Option<String>,
}

/// Withdraw an open offer. Authorized by the `cancel_key` returned at creation,
/// or (for a wagered offer) by the poster's authenticated wallet. Offers that
/// already matched are immutable — the game exists.
async fn park_cancel(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(q): Query<CancelQuery>,
    headers: HeaderMap,
) -> StatusCode {
    let caller = state.authed_wallet(&headers);
    let mut park = state.0.lobby.park.lock();
    let Some(o) = park.get(&id) else {
        return StatusCode::NOT_FOUND;
    };
    let by_key = q.key.as_deref() == Some(o.cancel_key.as_str());
    let by_wallet = match (&o.poster_addr, &caller) {
        (Some(p), Some(c)) => p.eq_ignore_ascii_case(c),
        _ => false,
    };
    if !(by_key || by_wallet) {
        return StatusCode::UNAUTHORIZED;
    }
    if o.status != "open" {
        return StatusCode::CONFLICT;
    }
    park.remove(&id);
    StatusCode::NO_CONTENT
}

#[derive(Serialize)]
struct OfferSummary {
    offer_id: Uuid,
    poster_addr: Option<String>,
    poster_name: Option<String>,
    poster_engine: Option<String>,
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
                poster_name: o.poster_name.clone(),
                poster_engine: o.poster_engine.clone(),
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
    /// Launch token for the acceptor's seat — absent when their bot plays it
    /// (the seat was dispatched to the agent; the browser just spectates).
    token: Option<String>,
    color: String,
    /// "bot" | "browser" — which client got the acceptor's seat.
    seat: String,
    spectate_path: String,
}

#[derive(Deserialize, Default)]
struct ParkAcceptReq {
    /// Optional self-declared display name / engine for the acceptor's seat.
    name: Option<String>,
    engine: Option<String>,
    /// "bot" seats the acceptor's connected agent; anything else = browser.
    seat: Option<String>,
    /// UCI option overrides for a bot seat.
    uci_options: Option<HashMap<String, String>>,
}

async fn park_accept(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    body: Option<Json<ParkAcceptReq>>,
) -> Result<Json<ParkAcceptResp>, StatusCode> {
    // Drain: reject before claiming the offer so it isn't consumed on a 503.
    state.reject_if_draining()?;
    let req = body.map(|Json(b)| b).unwrap_or_default();
    // Throttle accept attempts per-IP (same budget as offer creation).
    if state.0.limits.offers.check(&client_ip(&headers)).is_some() {
        return Err(StatusCode::TOO_MANY_REQUESTS);
    }
    let acceptor_bot = is_bot_seat(&req.seat);
    let acceptor_wallet = state.authed_wallet(&headers);

    // Claim the offer (open -> matching), capturing its terms.
    let claim = {
        let mut park = state.0.lobby.park.lock();
        let offer = park.get_mut(&id).ok_or(StatusCode::NOT_FOUND)?;
        if offer.status != "open" {
            return Err(StatusCode::CONFLICT);
        }
        offer.status = "matching".into();
        (
            offer.poster_addr.clone(),
            SeatMeta {
                name: offer.poster_name.clone(),
                engine: offer.poster_engine.clone(),
            },
            offer.poster_seat_bot,
            offer.poster_uci_options.clone(),
            offer.stake.clone(),
            offer.initial_secs,
            offer.increment_secs,
        )
    };
    let (poster_addr, poster_meta, poster_bot, poster_uci, stake, initial_secs, increment_secs) =
        claim;

    let unclaim = || {
        if let Some(o) = state.0.lobby.park.lock().get_mut(&id) {
            o.status = "open".into();
        }
    };
    // Wallets whose agents we claimed; any failure before the game exists
    // releases exactly these (correct-by-construction rollback).
    let mut claimed: Vec<String> = Vec::new();
    let release = |claimed: &[String]| {
        for w in claimed {
            state.0.agents.release(w);
        }
    };

    let tc = match validate_tc(initial_secs, increment_secs) {
        Ok(tc) => tc,
        Err(e) => {
            unclaim();
            return Err(e);
        }
    };

    // A bot seat is always wallet-bound; and a bot can't play itself.
    if acceptor_bot && acceptor_wallet.is_none() {
        unclaim();
        return Err(StatusCode::UNAUTHORIZED);
    }
    if poster_bot || acceptor_bot {
        if let (Some(p), Some(a)) = (&poster_addr, &acceptor_wallet) {
            if p.eq_ignore_ascii_case(a) {
                unclaim();
                return Err(StatusCode::BAD_REQUEST);
            }
        }
    }

    // Build the wager from authenticated wallets (poster + acceptor).
    let wager = if let Some(stake) = &stake {
        let acceptor = match &acceptor_wallet {
            Some(a) => a.clone(),
            None => {
                unclaim();
                return Err(StatusCode::UNAUTHORIZED);
            }
        };
        let poster = poster_addr.clone().unwrap_or_default();
        if poster.eq_ignore_ascii_case(&acceptor) {
            unclaim();
            return Err(StatusCode::BAD_REQUEST); // no self-play wagers
        }
        match build_wager(&poster, &acceptor, stake) {
            Ok(w) => Some(w),
            Err(e) => {
                unclaim();
                return Err(e);
            }
        }
    } else {
        None
    };

    // Claim both bots BEFORE creating the game, so we never open a game (or
    // an escrow) whose engine can't show up.
    let poster_delivery = if poster_bot {
        let wallet = poster_addr.clone().unwrap_or_default();
        match claim_agent_seat(&state.0.agents, wallet, poster_uci, &mut claimed) {
            Ok(d) => d,
            // Mid-game is not gone: keep the offer open, tell the acceptor to
            // retry (mirrors the acceptor arm below).
            Err(AgentUnavailable::Busy) => {
                unclaim();
                return Err(StatusCode::CONFLICT);
            }
            // Truly offline — the offer can never be honored; remove it.
            Err(AgentUnavailable::Offline) => {
                state.0.lobby.park.lock().remove(&id);
                return Err(StatusCode::GONE);
            }
        }
    } else {
        SeatDelivery::Browser
    };
    let (acceptor_delivery, acceptor_agent_meta) = if acceptor_bot {
        let wallet = acceptor_wallet.clone().unwrap_or_default();
        let meta = state.0.agents.view(&wallet).map(|(m, _)| m);
        match claim_agent_seat(
            &state.0.agents,
            wallet,
            clean_uci_options(req.uci_options),
            &mut claimed,
        ) {
            Ok(d) => (d, meta),
            Err(e) => {
                release(&claimed);
                unclaim();
                return Err(match e {
                    AgentUnavailable::Offline => StatusCode::FAILED_DEPENDENCY,
                    AgentUnavailable::Busy => StatusCode::CONFLICT,
                });
            }
        }
    } else {
        (SeatDelivery::Browser, None)
    };

    // Acceptor identity: explicit > their bot's registration > wallet/anon.
    let acceptor_meta = SeatMeta {
        name: req
            .name
            .as_deref()
            .and_then(sanitize_label)
            .or_else(|| acceptor_agent_meta.as_ref().map(|m| m.name.clone())),
        engine: req
            .engine
            .as_deref()
            .and_then(sanitize_label)
            .or_else(|| acceptor_agent_meta.as_ref().map(|m| m.engine.clone())),
    };

    // start_game creates the room, locks escrow, and DISPATCHES bot seats —
    // and aborts the game (escrow refunded) if an agent vanished, returning
    // Err. On any Err the claims are released and the offer reopens.
    let meta = [poster_meta, acceptor_meta];
    let resp = match state
        .start_game(
            tc,
            "park",
            wager,
            meta,
            [poster_delivery, acceptor_delivery],
        )
        .await
    {
        Ok(r) => r,
        Err(e) => {
            release(&claimed);
            unclaim();
            return Err(e);
        }
    };

    if let Some(offer) = state.0.lobby.park.lock().get_mut(&id) {
        offer.status = "matched".into();
        offer.game_id = Some(resp.game_id);
        // A bot-held seat's token stays server-side — the agent has it.
        offer.poster_token = (!poster_bot).then(|| resp.white_token.clone());
    }
    Ok(Json(ParkAcceptResp {
        game_id: resp.game_id,
        token: (!acceptor_bot).then_some(resp.black_token),
        color: "black".into(),
        seat: if acceptor_bot { "bot" } else { "browser" }.into(),
        spectate_path: resp.spectate_path,
    }))
}

#[derive(Serialize)]
struct ParkGetResp {
    status: String,
    game_id: Option<GameId>,
    token: Option<String>,
    color: Option<String>,
    /// "bot" when the poster's seat was dispatched to their agent (the browser
    /// should spectate instead of driving the seat).
    seat: Option<String>,
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
                token: if authorized {
                    o.poster_token.clone()
                } else {
                    None
                },
                color: (o.poster_token.is_some() || o.poster_seat_bot)
                    .then(|| "white".into())
                    .filter(|_| authorized),
                seat: Some(if o.poster_seat_bot { "bot" } else { "browser" }.into()),
            })
        }
        None => Json(ParkGetResp {
            status: "not_found".into(),
            game_id: None,
            token: None,
            color: None,
            seat: None,
        }),
    }
}

// --------------------------------------------------------------------------
// Gauntlet (tier queue)
// --------------------------------------------------------------------------

struct Ticket {
    addr: Option<String>,
    /// Self-declared identity for this queued player's seat (sanitized).
    meta: SeatMeta,
    status: String, // waiting | matched
    game_id: Option<GameId>,
    token: Option<String>,
    color: Option<String>,
    /// Gauntlet session this ticket belongs to (for standings), if any.
    session_id: Option<Uuid>,
    /// The seat is played by the owner's connected agent (browser spectates).
    seat_bot: bool,
    /// UCI option overrides for a bot seat, relayed to the agent on dispatch.
    uci_options: Vec<(String, String)>,
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
    /// Optional self-declared display name / engine (shown to the opponent).
    name: Option<String>,
    engine: Option<String>,
    /// "bot" seats the joiner's connected agent; anything else = browser.
    seat: Option<String>,
    /// UCI option overrides for a bot seat (applied by the agent per game).
    uci_options: Option<HashMap<String, String>>,
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
    // Drain: reject before enqueueing (a match would spawn a game).
    state.reject_if_draining()?;
    let tc = validate_tc(req.initial_secs, req.increment_secs)?;
    let bot = is_bot_seat(&req.seat);
    // Wagered tiers AND bot seats require auth; the seat (and the agent it
    // dispatches to) is always the authed wallet's. Casual browser seats need none.
    let addr = if req.stake.is_some() || bot {
        Some(
            state
                .authed_wallet(&headers)
                .ok_or(StatusCode::UNAUTHORIZED)?,
        )
    } else {
        None
    };

    let mut my_meta = SeatMeta {
        name: req.name.as_deref().and_then(sanitize_label),
        engine: req.engine.as_deref().and_then(sanitize_label),
    };
    if bot {
        // The bot must be online to queue as it; default its identity from the
        // registration so the opponent/lobby see what it actually runs.
        let wallet = addr.as_deref().unwrap_or_default();
        let (meta, _busy) = state
            .0
            .agents
            .view(wallet)
            .ok_or(StatusCode::FAILED_DEPENDENCY)?; // 424: bot offline
        my_meta.name = my_meta.name.or(Some(meta.name));
        my_meta.engine = my_meta.engine.or(Some(meta.engine));
    }

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
            // A stopped session (owner-stopped, or auto-stopped after the engine
            // forfeited a game without moving) takes no more games. This is the
            // server-side backstop that actually protects a staked user from a
            // dead engine — even if the client keeps trying to re-queue.
            if s.status != "running" {
                return Err(StatusCode::CONFLICT);
            }
        }
    }

    let key = format!(
        "{}|{}|{}",
        req.stake.clone().unwrap_or_else(|| "0".into()),
        req.initial_secs,
        req.increment_secs
    );
    let my_uci = clean_uci_options(req.uci_options);
    let my_id = Uuid::new_v4();
    state.0.lobby.tickets.lock().insert(
        my_id,
        Ticket {
            addr: addr.clone(),
            meta: my_meta.clone(),
            status: "waiting".into(),
            game_id: None,
            token: None,
            color: None,
            session_id: req.session_id,
            seat_bot: bot,
            uci_options: my_uci.clone(),
            created_at: Instant::now(),
        },
    );

    let opponent = {
        let mut queue = state.0.lobby.queue.lock();
        queue.entry(key.clone()).or_default().pop_front()
    };

    // No waiting opponent — sit in the queue.
    let Some(opp_id) = opponent else {
        state
            .0
            .lobby
            .queue
            .lock()
            .entry(key)
            .or_default()
            .push_back(my_id);
        return Ok(Json(QueueResp { ticket_id: my_id }));
    };

    // Paired: opponent = white, me = black.
    let (opp_addr, opp_meta, opp_session, opp_bot, opp_uci) = state
        .0
        .lobby
        .tickets
        .lock()
        .get(&opp_id)
        .map(|t| {
            (
                t.addr.clone(),
                t.meta.clone(),
                t.session_id,
                t.seat_bot,
                t.uci_options.clone(),
            )
        })
        .unwrap_or((None, SeatMeta::default(), None, false, Vec::new()));

    // Rollback used on any failure between popping the opponent and the game
    // existing. `release` frees claimed agents; the inline requeues make sure no
    // player is orphaned (a still-viable opponent goes back to the front).
    let release = |claimed: &[String]| {
        for w in claimed {
            state.0.agents.release(w);
        }
    };
    let requeue_opp_then_fail = |code: StatusCode| -> StatusCode {
        state
            .0
            .lobby
            .queue
            .lock()
            .entry(key.clone())
            .or_default()
            .push_front(opp_id);
        state.0.lobby.tickets.lock().remove(&my_id);
        code
    };

    // Guard a stopped gauntlet session from being dragged into a NEW wagered
    // game right before we commit. The entry check (~"status != running" above)
    // races the async auto-stop, and a session can be stopped while its ticket
    // already sits waiting in the queue — the entry gate never sees that ticket.
    // So re-check both sides here: a session is stopped if it exists and isn't
    // "running". Non-gauntlet joins pass `None` and are unaffected.
    let session_stopped = |sid: Option<Uuid>| -> bool {
        sid.is_some_and(|sid| {
            state
                .0
                .lobby
                .gauntlets
                .lock()
                .get(&sid)
                .is_some_and(|s| s.status != "running")
        })
    };
    if session_stopped(opp_session) {
        // The popped opponent's session stopped: its ticket is stale. Drop it
        // and keep waiting for a live opponent.
        state.0.lobby.tickets.lock().remove(&opp_id);
        state.0.lobby.queue.lock().entry(key).or_default().push_back(my_id);
        return Ok(Json(QueueResp { ticket_id: my_id }));
    }
    if session_stopped(req.session_id) {
        // My own session stopped since I joined (raced the auto-stop): don't
        // open a wagered game — put the opponent back for the next live joiner.
        return Err(requeue_opp_then_fail(StatusCode::CONFLICT));
    }

    let wager = if let Some(stake) = req.stake.clone() {
        let white = match opp_addr.clone() {
            Some(w) => w,
            // Wagered pairing but the opponent has no wallet (shouldn't happen —
            // staked tickets are authed): keep me waiting, drop the bad opponent.
            None => {
                state.0.lobby.tickets.lock().remove(&opp_id);
                state.0.lobby.queue.lock().entry(key).or_default().push_back(my_id);
                return Ok(Json(QueueResp { ticket_id: my_id }));
            }
        };
        let black = match addr.clone() {
            Some(b) => b,
            None => return Err(requeue_opp_then_fail(StatusCode::UNAUTHORIZED)),
        };
        if white.eq_ignore_ascii_case(&black) {
            return Err(requeue_opp_then_fail(StatusCode::BAD_REQUEST));
        }
        match build_wager(&white, &black, &stake) {
            Ok(w) => Some(w),
            Err(e) => return Err(requeue_opp_then_fail(e)),
        }
    } else {
        None
    };

    // Claim both bots BEFORE creating the game, so we never open a game (or an
    // escrow) whose engine can't show up.
    let mut claimed: Vec<String> = Vec::new();
    let white_delivery = if opp_bot {
        let w = opp_addr.clone().unwrap_or_default();
        match claim_agent_seat(&state.0.agents, w, opp_uci, &mut claimed) {
            Ok(d) => d,
            // The opponent's bot went offline/busy since it queued: its ticket
            // is stale — drop it and put me back to wait for a fresh opponent.
            Err(_) => {
                state.0.lobby.tickets.lock().remove(&opp_id);
                state.0.lobby.queue.lock().entry(key).or_default().push_back(my_id);
                return Ok(Json(QueueResp { ticket_id: my_id }));
            }
        }
    } else {
        SeatDelivery::Browser
    };
    let black_delivery = if bot {
        let w = addr.clone().unwrap_or_default();
        match claim_agent_seat(&state.0.agents, w, my_uci, &mut claimed) {
            Ok(d) => d,
            // My own bot can't play — fail my join, keep the opponent waiting.
            Err(e) => {
                release(&claimed);
                return Err(requeue_opp_then_fail(match e {
                    AgentUnavailable::Offline => StatusCode::FAILED_DEPENDENCY,
                    AgentUnavailable::Busy => StatusCode::CONFLICT,
                }));
            }
        }
    } else {
        SeatDelivery::Browser
    };

    // start_game creates the room, locks escrow, and DISPATCHES bot seats — and
    // aborts (escrow refunded) if an agent vanished, returning Err. On any Err
    // the claims are released and both players are put back.
    let resp = match state
        .start_game(tc, "gauntlet", wager, [opp_meta, my_meta], [white_delivery, black_delivery])
        .await
    {
        Ok(r) => r,
        Err(e) => {
            release(&claimed);
            return Err(requeue_opp_then_fail(e));
        }
    };

    // Attribute the game's result to any gauntlet sessions involved.
    let mut links = Vec::new();
    if let Some(sid) = opp_session {
        links.push((sid, Color::White));
    }
    if let Some(sid) = req.session_id {
        links.push((sid, Color::Black));
    }
    if !links.is_empty() {
        state.0.lobby.game_to_gauntlet.lock().insert(resp.game_id, links);
    }

    // Mark both tickets matched. A bot-held seat's token stays server-side (the
    // agent has it); the browser spectates.
    let mut tickets = state.0.lobby.tickets.lock();
    if let Some(t) = tickets.get_mut(&opp_id) {
        t.status = "matched".into();
        t.game_id = Some(resp.game_id);
        t.token = (!opp_bot).then(|| resp.white_token.clone());
        t.color = Some("white".into());
    }
    if let Some(t) = tickets.get_mut(&my_id) {
        t.status = "matched".into();
        t.game_id = Some(resp.game_id);
        t.token = (!bot).then_some(resp.black_token);
        t.color = Some("black".into());
    }
    drop(tickets);

    Ok(Json(QueueResp { ticket_id: my_id }))
}

#[derive(Serialize)]
struct TicketResp {
    status: String,
    game_id: Option<GameId>,
    token: Option<String>,
    color: Option<String>,
    /// "bot" when this seat was dispatched to the caller's agent (the browser
    /// should spectate instead of driving the seat); "browser" otherwise.
    seat: Option<String>,
}

async fn queue_get(State(state): State<AppState>, Path(id): Path<Uuid>) -> Json<TicketResp> {
    let tickets = state.0.lobby.tickets.lock();
    match tickets.get(&id) {
        Some(t) => Json(TicketResp {
            status: t.status.clone(),
            game_id: t.game_id,
            token: t.token.clone(),
            color: t.color.clone(),
            seat: Some(if t.seat_bot { "bot" } else { "browser" }.into()),
        }),
        None => Json(TicketResp {
            status: "not_found".into(),
            game_id: None,
            token: None,
            color: None,
            seat: None,
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
    // Drain: reject new gauntlets during maintenance.
    state.reject_if_draining()?;
    validate_tc(req.initial_secs, req.increment_secs)?;
    let addr = if req.stake.is_some() {
        Some(
            state
                .authed_wallet(&headers)
                .ok_or(StatusCode::UNAUTHORIZED)?,
        )
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
    /// Round-robin schedule (circle method): each inner vec is one round's
    /// pairings by player id. Games are dispatched one round at a time so that
    /// no entrant is ever in two games at once (a bot agent plays one game).
    rounds: Vec<Vec<(String, String)>>,
    /// Index of the round currently in progress.
    current_round: usize,
    /// Real (non-forfeit) games still unfinished in the current round; when it
    /// hits 0 the next round is dispatched (or the pool settles).
    round_remaining: usize,
    /// Entrants whose seat is played by their connected agent (player id ->
    /// dispatch info). In-memory only — a restart abandons in-flight tournaments.
    entrant_bots: HashMap<String, BotEntry>,
    /// For a root-settled (large) tournament: the payout leaves, so the server
    /// can serve Merkle proofs to claimers. (addr, amount in base units)
    payout_leaves: Vec<(String, u128)>,
    created_at: Instant,
}

/// Dispatch info for a bot entrant (its seat is played by its connected agent).
#[derive(Clone)]
struct BotEntry {
    wallet: String,
    uci_options: Vec<(String, String)>,
}

#[derive(Clone, Serialize)]
struct TourneyGame {
    game_id: GameId,
    white: String,
    black: String,
    /// 0-based round this game belongs to.
    round: usize,
    // Launch tokens are seat capabilities — never serialize them into the public
    // tournament view. Each entrant fetches only its own via GET
    // /tournaments/{id}/my-games (authenticated). Leaking them lets anyone play
    // (and throw) any game, steering the on-chain pool payout.
    #[serde(skip)]
    white_token: String,
    #[serde(skip)]
    black_token: String,
}

/// Round-robin schedule by the circle method: for `n` entrants, produce `n-1`
/// rounds (n even) or `n` rounds (n odd — one bye per round), each pairing every
/// entrant at most once and every distinct pair exactly once overall. Pairings
/// are index pairs into a `0..n` entrant list.
fn round_robin_rounds(n: usize) -> Vec<Vec<(usize, usize)>> {
    if n < 2 {
        return Vec::new();
    }
    let bye = n % 2 == 1;
    let m = if bye { n + 1 } else { n }; // even count; index `n` is the bye seat
    let mut arr: Vec<usize> = (0..m).collect();
    let mut schedule = Vec::with_capacity(m - 1);
    for _ in 0..m - 1 {
        let mut round = Vec::with_capacity(m / 2);
        for i in 0..m / 2 {
            let (a, b) = (arr[i], arr[m - 1 - i]);
            // Skip any pairing that involves the bye seat (index == n).
            if a < n && b < n {
                round.push((a, b));
            }
        }
        schedule.push(round);
        // Fix arr[0], rotate the rest right by one (the circle method).
        arr[1..].rotate_right(1);
    }
    schedule
}

/// Apply a game (or forfeit) result to tournament standings.
fn score_pair(scores: &mut HashMap<String, f64>, white: &str, black: &str, winner: Option<Color>) {
    match winner {
        Some(Color::White) => *scores.entry(white.to_string()).or_insert(0.0) += 1.0,
        Some(Color::Black) => *scores.entry(black.to_string()).or_insert(0.0) += 1.0,
        None => {
            *scores.entry(white.to_string()).or_insert(0.0) += 0.5;
            *scores.entry(black.to_string()).or_insert(0.0) += 0.5;
        }
    }
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
    // Drain: reject before opening an on-chain pool (burns oracle gas) for a
    // tournament that couldn't be started (tourney_start is also drained).
    state.reject_if_draining()?;
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
        let buy_in = buy_in_str
            .parse::<U256>()
            .map_err(|_| StatusCode::BAD_REQUEST)?;
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
            rounds: Vec::new(),
            current_round: 0,
            round_remaining: 0,
            entrant_bots: HashMap::new(),
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
    /// "bot" seats the entrant's connected agent for all of its games.
    seat: Option<String>,
    /// UCI option overrides for a bot entrant (applied per game).
    uci_options: Option<HashMap<String, String>>,
}

async fn tourney_join(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(req): Json<JoinReq>,
) -> StatusCode {
    // Drain: reject before locking a buy-in on-chain for a tournament that
    // couldn't be started (this handler returns a bare StatusCode).
    if state.maintenance_on() {
        return StatusCode::SERVICE_UNAVAILABLE;
    }
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

    let bot = is_bot_seat(&req.seat);
    // Buy-in tournament: entrant is the authenticated wallet; lock on-chain.
    if let Some(buy_in_str) = buy_in {
        let wallet = match state.authed_wallet(&headers) {
            Some(w) => w,
            None => return StatusCode::UNAUTHORIZED,
        };
        // A bot entrant must be online BEFORE we lock the buy-in on-chain — never
        // stake USDC for an engine that can't show up.
        if bot && state.0.agents.view(&wallet).is_none() {
            return StatusCode::FAILED_DEPENDENCY; // 424: bot offline
        }
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
                    t.players.push(wallet.clone());
                }
                if bot {
                    t.entrant_bots.insert(
                        wallet.clone(),
                        BotEntry {
                            wallet,
                            uci_options: clean_uci_options(req.uci_options),
                        },
                    );
                }
            }
        }
        persist_tournament(&state, id).await;
        StatusCode::OK
    } else {
        // Casual tournament: a display name (sanitized — it flows into lobby
        // views and display helpers, so control chars / absurd input are out).
        let name = match req.player.as_deref().and_then(sanitize_label) {
            Some(n) => n,
            None => return StatusCode::BAD_REQUEST,
        };
        // A casual bot entrant is still wallet-bound (the agent is), so it needs
        // auth + an online bot, even though the tournament itself is free.
        let bot_wallet = if bot {
            let wallet = match state.authed_wallet(&headers) {
                Some(w) => w,
                None => return StatusCode::UNAUTHORIZED,
            };
            if state.0.agents.view(&wallet).is_none() {
                return StatusCode::FAILED_DEPENDENCY; // 424: bot offline
            }
            Some(wallet)
        } else {
            None
        };
        {
            let mut t = state.0.lobby.tournaments.lock();
            if let Some(t) = t.get_mut(&id) {
                // Names are the entrant identity in a casual tournament (and the
                // entrant_bots key), so they must be unique — otherwise a later
                // joiner reusing a name would hijack the existing entrant's seat.
                if t.players.iter().any(|p| p.eq_ignore_ascii_case(&name)) {
                    return StatusCode::CONFLICT; // 409: display name already taken
                }
                t.players.push(name.clone());
                if let Some(wallet) = bot_wallet {
                    t.entrant_bots.insert(
                        name,
                        BotEntry {
                            wallet,
                            uci_options: clean_uci_options(req.uci_options),
                        },
                    );
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
    /// Round currently in progress (games carry their own `round`), so a client
    /// can pick out the active game to play/spectate.
    current_round: usize,
    /// Total rounds in the schedule (0 until started).
    total_rounds: usize,
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
        current_round: t.current_round,
        total_rounds: t.rounds.len(),
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
    /// Empty when this seat is played by the caller's bot — the browser should
    /// spectate `game_id` rather than connect with a token.
    token: String,
    opponent: String,
    /// 0-based round this game belongs to.
    round: usize,
    /// "bot" | "browser".
    seat: String,
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
        state
            .authed_wallet(&headers)
            .ok_or(StatusCode::UNAUTHORIZED)?
    } else {
        q.player.ok_or(StatusCode::BAD_REQUEST)?
    };
    // A bot entrant's seats are played by its agent — hand the browser no token
    // (it spectates); a browser entrant gets its real launch token.
    let is_bot = t.entrant_bots.contains_key(&me);
    let seat = if is_bot { "bot" } else { "browser" };
    let tok = |real: &str| if is_bot { String::new() } else { real.to_string() };
    let mut mine = Vec::new();
    for g in &t.games {
        if g.white.eq_ignore_ascii_case(&me) {
            mine.push(MyGame {
                game_id: g.game_id,
                color: "white".into(),
                token: tok(&g.white_token),
                opponent: g.black.clone(),
                round: g.round,
                seat: seat.into(),
            });
        } else if g.black.eq_ignore_ascii_case(&me) {
            mine.push(MyGame {
                game_id: g.game_id,
                color: "black".into(),
                token: tok(&g.black_token),
                opponent: g.white.clone(),
                round: g.round,
                seat: seat.into(),
            });
        }
    }
    Ok(Json(mine))
}

/// Start a round-robin tournament. Games are dispatched **one round at a time**
/// (circle-method schedule), so no entrant is ever in two games at once — that's
/// what lets a bot entrant (a single agent) play, and it also stops the games a
/// player isn't in yet from being reaped before they're played. Games are
/// unwagered; the buy-in *pool* is the money, decided by final standings.
/// Organizer-authenticated for buy-in tournaments.
async fn tourney_start(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Vec<TourneyGame>>, StatusCode> {
    // Drain: reject before spawning any games.
    state.reject_if_draining()?;
    let caller = state.authed_wallet(&headers);
    {
        let mut ts = state.0.lobby.tournaments.lock();
        let t = ts.get_mut(&id).ok_or(StatusCode::NOT_FOUND)?;
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
        validate_tc(t.initial_secs, t.increment_secs)?;
        // Build the round schedule by player id, then start at round 0.
        let players = t.players.clone();
        t.rounds = round_robin_rounds(players.len())
            .iter()
            .map(|round| {
                round
                    .iter()
                    .map(|&(i, j)| (players[i].clone(), players[j].clone()))
                    .collect()
            })
            .collect();
        t.current_round = 0;
        t.status = "running".into();
    }
    if let Some(db) = &state.0.db {
        let _ = db.set_tournament_status(id, "running").await;
    }

    // Dispatch the first round (skipping any all-forfeit rounds; settling if the
    // schedule is empty). Subsequent rounds are dispatched by results_task as
    // each round finishes.
    dispatch_from_current(&state, id).await;

    let games = state
        .0
        .lobby
        .tournaments
        .lock()
        .get(&id)
        .map(|t| t.games.clone())
        .unwrap_or_default();
    Ok(Json(games))
}

/// Dispatch the tournament's current round; if it produced no real games (all
/// forfeits, or nothing left), advance and try the next — settling the pool once
/// the schedule is exhausted. Called on start and after each round finishes.
async fn dispatch_from_current(state: &AppState, tid: Uuid) {
    loop {
        let round_idx = {
            let ts = state.0.lobby.tournaments.lock();
            match ts.get(&tid) {
                Some(t) if t.status == "running" => {
                    (t.current_round < t.rounds.len()).then_some(t.current_round)
                }
                _ => return, // gone, abandoned, or already settled
            }
        };
        let Some(round_idx) = round_idx else {
            // Schedule exhausted → complete + settle the pool.
            if let Some(t) = state.0.lobby.tournaments.lock().get_mut(&tid) {
                t.status = "complete".into();
            }
            settle_tournament(state, tid).await;
            return;
        };
        if dispatch_round(state, tid, round_idx).await > 0 {
            return; // games in flight; results_task advances when they finish
        }
        // All-forfeit (or empty) round → advance and try the next.
        if let Some(t) = state.0.lobby.tournaments.lock().get_mut(&tid) {
            t.current_round += 1;
        }
    }
}

/// Dispatch every pairing of round `round_idx`: create a game per pairing whose
/// seats can be filled, and immediately FORFEIT any pairing where a bot seat is
/// offline/busy (its opponent wins; both unavailable ⇒ draw). Sets
/// `round_remaining` to (and returns) the number of real games created.
async fn dispatch_round(state: &AppState, tid: Uuid, round_idx: usize) -> usize {
    // Snapshot pairings + tc + bot entrants (never hold the lock across .await).
    let (pairings, tc, bots) = {
        let ts = state.0.lobby.tournaments.lock();
        let Some(t) = ts.get(&tid) else { return 0 };
        let pairings = t.rounds.get(round_idx).cloned().unwrap_or_default();
        let Ok(tc) = validate_tc(t.initial_secs, t.increment_secs) else {
            return 0;
        };
        (pairings, tc, t.entrant_bots.clone())
    };

    let seat_meta = |p: &str| SeatMeta {
        name: Some(if p.starts_with("0x") && p.len() == 42 {
            short_addr(p)
        } else {
            p.to_string()
        }),
        engine: None,
    };
    // Build a seat delivery for an entrant; `Err(())` = its bot is unavailable.
    // A claimed wallet is pushed onto `claimed` for rollback.
    let make_seat = |id: &str, claimed: &mut Vec<String>| -> Result<SeatDelivery, ()> {
        match bots.get(id) {
            None => Ok(SeatDelivery::Browser),
            Some(be) => {
                claim_agent_seat(&state.0.agents, be.wallet.clone(), be.uci_options.clone(), claimed)
                    .map_err(|_| ())
            }
        }
    };

    let mut created: Vec<TourneyGame> = Vec::new();
    let mut forfeits: Vec<(String, String, Option<Color>)> = Vec::new();
    for (white, black) in pairings {
        let mut claimed: Vec<String> = Vec::new();
        let wd = make_seat(&white, &mut claimed);
        let bd = make_seat(&black, &mut claimed);
        let release = |claimed: &[String]| {
            for w in claimed {
                state.0.agents.release(w);
            }
        };
        match (wd, bd) {
            (Ok(wd), Ok(bd)) => {
                match state
                    .start_game(
                        tc,
                        "tournament",
                        None,
                        [seat_meta(&white), seat_meta(&black)],
                        [wd, bd],
                    )
                    .await
                {
                    Ok(resp) => created.push(TourneyGame {
                        game_id: resp.game_id,
                        white: white.clone(),
                        black: black.clone(),
                        round: round_idx,
                        white_token: resp.white_token,
                        black_token: resp.black_token,
                    }),
                    // start_game aborted (an agent vanished after claim): neither
                    // side got to play → score it a draw; release our claims.
                    Err(_) => {
                        release(&claimed);
                        forfeits.push((white, black, None));
                    }
                }
            }
            (Err(()), Ok(_)) => {
                release(&claimed); // black was claimed; white's bot is absent
                forfeits.push((white, black, Some(Color::Black)));
            }
            (Ok(_), Err(())) => {
                release(&claimed);
                forfeits.push((white, black, Some(Color::White)));
            }
            (Err(()), Err(())) => forfeits.push((white, black, None)),
        }
    }

    // Apply forfeit scores + record the created games (under the lock).
    // Ordering matters. Register routing (game_to_tournament) FIRST and record
    // the games, THEN set round_remaining to the count still unresolved. A real
    // game can't finish in this sub-ms window, but doing it the other way would
    // let a game that finished during dispatch drop its outcome and stall the
    // round forever; this keeps it correct regardless.
    {
        let mut map = state.0.lobby.game_to_tournament.lock();
        for g in &created {
            map.insert(g.game_id, tid);
        }
    }
    {
        let mut ts = state.0.lobby.tournaments.lock();
        if let Some(t) = ts.get_mut(&tid) {
            for (w, b, winner) in &forfeits {
                score_pair(&mut t.scores, w, b, *winner);
            }
            t.games.extend(created.iter().cloned());
        }
    }
    {
        // Count only games still unresolved — a game that already finished
        // removed itself from game_to_tournament. Snapshot that map first (its
        // own lock, released) to preserve record_outcome's lock order.
        let live = {
            let map = state.0.lobby.game_to_tournament.lock();
            created
                .iter()
                .filter(|g| map.contains_key(&g.game_id))
                .count()
        };
        if let Some(t) = state.0.lobby.tournaments.lock().get_mut(&tid) {
            t.round_remaining = live;
        }
    }
    if let Some(db) = &state.0.db {
        for g in &created {
            let _ = db
                .add_tournament_game(tid, g.game_id, &g.white, &g.black)
                .await;
        }
    }
    created.len()
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
        // A `running` tournament didn't reach settlement before the restart.
        // Round-based dispatch persists only the rounds played SO FAR, so
        // "all persisted games finished" does NOT mean the tournament is
        // complete — settling here would risk paying the pool out on partial
        // standings (and the contract's `AlreadySettled` makes that permanent).
        // Also, forfeit results aren't persisted, so re-derived standings would
        // be wrong regardless. So we abandon it: entrants recover their buy-in
        // via the contract's `claimRefund`. A tournament that actually finished
        // AND enqueued settlement is completed by the durable settlement outbox
        // (drained separately on boot), which carries the correct standings —
        // not by this path.
        tracing::warn!(
            tournament = %t.id,
            "tournament interrupted by restart — marking abandoned; entrants refund via claimRefund"
        );
        let _ = db.set_tournament_status(t.id, "abandoned").await;
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
                db.enqueue_tournament_settlement(tid, "root", payload)
                    .await?;
                Ok(())
            }
            None => state
                .0
                .settlement
                .settle_tournament_root(tid, leaves)
                .await
                .map(|_| ()),
        }
    } else {
        match &state.0.db {
            Some(db) => {
                let payload = json!({
                    "winners": addrs.iter().map(|a| format!("{a:?}")).collect::<Vec<_>>(),
                    "payouts": payouts.iter().map(|p| p.to_string()).collect::<Vec<_>>(),
                });
                db.enqueue_tournament_settlement(tid, "direct", payload)
                    .await?;
                Ok(())
            }
            None => {
                state
                    .0
                    .settlement
                    .settle_tournament(tid, addrs, payouts)
                    .await
            }
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
        t.get(&id)
            .map(|t| t.payout_leaves.clone())
            .unwrap_or_default()
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
        .filter_map(|(a, amt)| {
            a.parse::<Address>()
                .ok()
                .map(|a| tournament_leaf(a, U256::from(*amt)))
        })
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::AgentMeta;
    use crate::{AppState, Inner};
    use protocol::ServerToAgent;
    use std::sync::Arc;

    // A minimal in-memory AppState (no DB, log-only settlement) for driving the
    // matchmaking handlers directly. The returned receivers are kept alive so the
    // room's cleanup/results senders stay valid for the test's lifetime.
    fn test_state() -> (
        AppState,
        mpsc::Receiver<GameId>,
        mpsc::Receiver<crate::GameOutcome>,
    ) {
        let (cleanup_tx, cleanup_rx) = mpsc::channel(16);
        let (results_tx, results_rx) = mpsc::channel(16);
        let state = AppState(Arc::new(Inner {
            rooms: Mutex::new(HashMap::new()),
            live_games: Mutex::new(HashMap::new()),
            tokens: Mutex::new(HashMap::new()),
            settlement: ledger::from_env(),
            db: None,
            lobby: Lobby::default(),
            auth: crate::auth::Auth::default(),
            agents: crate::agents::Agents::default(),
            limits: crate::ratelimit::RateLimits::from_env(),
            maintenance: std::sync::atomic::AtomicBool::new(false),
            admin_wallet: Mutex::new(None),
            cleanup_tx,
            results_tx,
        }));
        (state, cleanup_rx, results_rx)
    }

    fn bearer(token: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("authorization", format!("Bearer {token}").parse().unwrap());
        h
    }

    fn bot_req() -> QueueReq {
        QueueReq {
            stake: None,
            initial_secs: 60,
            increment_secs: 1,
            session_id: None,
            name: None,
            engine: None,
            seat: Some("bot".into()),
            uci_options: None,
        }
    }

    fn register_bot(state: &AppState, wallet: &str) -> (String, mpsc::Receiver<ServerToAgent>) {
        let (tx, rx) = mpsc::channel::<ServerToAgent>(8);
        state.0.agents.register(
            wallet,
            AgentMeta {
                name: "bot".into(),
                engine: "e".into(),
                options: vec![],
            },
            tx,
        );
        (state.0.auth.mint_session(wallet), rx)
    }

    #[tokio::test]
    async fn gauntlet_pairs_two_bots_and_dispatches_seats() {
        let (state, _c, _r) = test_state();
        let wa = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let wb = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let (ta, mut rx_a) = register_bot(&state, wa);
        let (tb, mut rx_b) = register_bot(&state, wb);

        // Bot A queues first — no opponent yet, so it only waits (NOT claimed,
        // NOT dispatched).
        queue_join(State(state.clone()), bearer(&ta), Json(bot_req()))
            .await
            .expect("A join");
        assert!(rx_a.try_recv().is_err(), "A must not be dispatched while waiting");
        assert!(state.0.agents.claim(wa).is_ok(), "A not claimed while waiting");
        state.0.agents.release(wa);

        // Bot B queues — pairs with A; BOTH seats dispatch to their agents.
        let r2 = queue_join(State(state.clone()), bearer(&tb), Json(bot_req()))
            .await
            .expect("B join");

        assert!(
            matches!(rx_a.try_recv(), Ok(ServerToAgent::AssignSeat { .. })),
            "A (white) got its seat"
        );
        assert!(
            matches!(rx_b.try_recv(), Ok(ServerToAgent::AssignSeat { .. })),
            "B (black) got its seat"
        );

        // B's ticket is matched, holds NO launch token (its bot has it), seat=bot.
        let tr = queue_get(State(state.clone()), Path(r2.0.ticket_id)).await.0;
        assert_eq!(tr.status, "matched");
        assert!(tr.token.is_none(), "a bot seat's token stays server-side");
        assert_eq!(tr.seat.as_deref(), Some("bot"));

        // Both agents are now busy (claimed + bound to the game).
        assert!(state.0.agents.claim(wa).is_err(), "A busy");
        assert!(state.0.agents.claim(wb).is_err(), "B busy");
    }

    /// Insert a fresh running gauntlet session and return its id.
    fn running_session(lobby: &Lobby, stake: Option<&str>) -> Uuid {
        let sid = Uuid::new_v4();
        lobby.gauntlets.lock().insert(
            sid,
            GauntletSession {
                addr: None,
                stake: stake.map(str::to_string),
                initial_secs: 60,
                increment_secs: 1,
                status: "running".into(),
                games: 0,
                wins: 0,
                losses: 0,
                draws: 0,
                created_at: Instant::now(),
            },
        );
        sid
    }

    /// A game outcome for a contested game (both seats showed up). Never-started
    /// reaps set `plies`/`*_showed_up` explicitly at the call site instead.
    fn outcome(game_id: GameId, winner: Option<Color>, plies: u32) -> GameOutcome {
        GameOutcome { game_id, winner, plies, white_showed_up: true, black_showed_up: true }
    }

    #[test]
    fn gauntlet_auto_stops_when_a_seat_forfeits_without_moving() {
        let lobby = Lobby::default();

        // Black seat lost having never moved (White moved once → ply 1): dead
        // engine, so the session auto-stops instead of bleeding the stake.
        let black_sid = running_session(&lobby, Some("1000000"));
        let g1 = Uuid::new_v4();
        lobby.game_to_gauntlet.lock().insert(g1, vec![(black_sid, Color::Black)]);
        lobby.record_outcome(&outcome(g1, Some(Color::White), 1));

        // White seat lost having never moved (a no-show forfeit → ply 0).
        let white_sid = running_session(&lobby, Some("1000000"));
        let g2 = Uuid::new_v4();
        lobby.game_to_gauntlet.lock().insert(g2, vec![(white_sid, Color::White)]);
        lobby.record_outcome(&outcome(g2, Some(Color::Black), 0));

        let g = lobby.gauntlets.lock();
        assert_eq!(g.get(&black_sid).unwrap().losses, 1);
        assert_eq!(g.get(&black_sid).unwrap().status, "stopped");
        assert_eq!(g.get(&white_sid).unwrap().status, "stopped");
    }

    #[test]
    fn gauntlet_keeps_running_after_a_contested_loss() {
        let lobby = Lobby::default();
        let sid = running_session(&lobby, Some("1000000"));
        // Black seat lost a real game (both sides moved → ply >= 2): keep going.
        let gid = Uuid::new_v4();
        lobby.game_to_gauntlet.lock().insert(gid, vec![(sid, Color::Black)]);
        lobby.record_outcome(&outcome(gid, Some(Color::White), 42));

        let g = lobby.gauntlets.lock();
        let s = g.get(&sid).unwrap();
        assert_eq!(s.losses, 1);
        assert_eq!(s.status, "running", "a genuine loss must not stop the gauntlet");
    }

    #[test]
    fn no_show_draw_stops_only_the_seat_that_failed_to_show() {
        let lobby = Lobby::default();
        // A never-started reap that drew (plies == 0): White showed up (ready),
        // Black hung at init (connected, never readied). Only Black's session
        // stops; White's — the healthy seat — keeps running.
        let white_sid = running_session(&lobby, Some("1000000"));
        let black_sid = running_session(&lobby, Some("1000000"));
        let gid = Uuid::new_v4();
        lobby
            .game_to_gauntlet
            .lock()
            .insert(gid, vec![(white_sid, Color::White), (black_sid, Color::Black)]);
        lobby.record_outcome(&GameOutcome {
            game_id: gid,
            winner: None,
            plies: 0,
            white_showed_up: true,
            black_showed_up: false,
        });
        {
            let g = lobby.gauntlets.lock();
            assert_eq!(g.get(&white_sid).unwrap().status, "running", "the seat that showed up is spared");
            assert_eq!(g.get(&black_sid).unwrap().status, "stopped", "the no-show seat stops");
        }

        // A real drawn game (both played, plies > 0) never stops.
        let live_sid = running_session(&lobby, None);
        let g2 = Uuid::new_v4();
        lobby.game_to_gauntlet.lock().insert(g2, vec![(live_sid, Color::White)]);
        lobby.record_outcome(&outcome(g2, None, 40));
        assert_eq!(lobby.gauntlets.lock().get(&live_sid).unwrap().status, "running");
    }

    #[tokio::test]
    async fn stopped_session_waiting_ticket_is_not_paired_into_a_new_game() {
        let (state, _c, _r) = test_state();
        let sid = running_session(&state.0.lobby, None);
        let req = |session_id| QueueReq {
            stake: None,
            initial_secs: 60,
            increment_secs: 1,
            session_id,
            name: None,
            engine: None,
            seat: None,
            uci_options: None,
        };

        // The session parks a waiting ticket (no opponent yet); no game exists.
        queue_join(State(state.clone()), HeaderMap::new(), Json(req(Some(sid))))
            .await
            .expect("first join waits");
        assert!(state.0.rooms.lock().is_empty());

        // The session stops (owner-stop, or auto-stop after a no-move forfeit).
        state.0.lobby.gauntlets.lock().get_mut(&sid).unwrap().status = "stopped".into();

        // An opponent joins the same tier and pops the stopped session's stale
        // ticket — the pair-time re-check must drop it, not open a new game.
        queue_join(State(state.clone()), HeaderMap::new(), Json(req(None)))
            .await
            .expect("second join waits (stale ticket dropped)");
        assert!(
            state.0.rooms.lock().is_empty(),
            "a stopped session's stale ticket must not open a new game",
        );
    }

    #[tokio::test]
    async fn gauntlet_bot_seat_requires_auth() {
        let (state, _c, _r) = test_state();
        let err = queue_join(State(state), HeaderMap::new(), Json(bot_req()))
            .await
            .err();
        assert_eq!(err, Some(StatusCode::UNAUTHORIZED));
    }

    #[tokio::test]
    async fn gauntlet_offline_bot_join_is_rejected() {
        let (state, _c, _r) = test_state();
        // Authenticated, but no agent connected for this wallet.
        let token = state
            .0
            .auth
            .mint_session("0xcccccccccccccccccccccccccccccccccccccccc");
        let err = queue_join(State(state), bearer(&token), Json(bot_req()))
            .await
            .err();
        assert_eq!(err, Some(StatusCode::FAILED_DEPENDENCY)); // 424: bot offline
    }

    #[tokio::test]
    async fn gauntlet_casual_browser_still_pairs() {
        let (state, _c, _r) = test_state();
        let browser = || QueueReq {
            stake: None,
            initial_secs: 60,
            increment_secs: 1,
            session_id: None,
            name: None,
            engine: None,
            seat: None,
            uci_options: None,
        };
        queue_join(State(state.clone()), HeaderMap::new(), Json(browser()))
            .await
            .expect("p1");
        let r2 = queue_join(State(state.clone()), HeaderMap::new(), Json(browser()))
            .await
            .expect("p2");
        let tr = queue_get(State(state.clone()), Path(r2.0.ticket_id)).await.0;
        assert_eq!(tr.status, "matched");
        assert!(tr.token.is_some(), "a browser seat gets a launch token");
        assert_eq!(tr.seat.as_deref(), Some("browser"));
    }

    #[test]
    fn round_robin_covers_every_pair_exactly_once() {
        for n in 2..=9 {
            let rounds = round_robin_rounds(n);
            let expected = if n % 2 == 0 { n - 1 } else { n };
            assert_eq!(rounds.len(), expected, "n={n}: round count");
            let mut all_pairs = std::collections::HashSet::new();
            for round in &rounds {
                let mut seen = std::collections::HashSet::new();
                for &(a, b) in round {
                    assert!(a < n && b < n, "n={n}: index in range");
                    assert!(seen.insert(a) && seen.insert(b), "n={n}: player twice in a round");
                    let key = if a < b { (a, b) } else { (b, a) };
                    assert!(all_pairs.insert(key), "n={n}: pair {key:?} repeated");
                }
            }
            assert_eq!(all_pairs.len(), n * (n - 1) / 2, "n={n}: every pair once");
        }
    }

    #[tokio::test]
    async fn tournament_dispatches_bots_round_by_round_then_settles() {
        let (state, _c, results_rx) = test_state();
        let wallets = [
            "0x1111111111111111111111111111111111111111",
            "0x2222222222222222222222222222222222222222",
            "0x3333333333333333333333333333333333333333",
            "0x4444444444444444444444444444444444444444",
        ];
        let names = ["Alpha", "Bravo", "Charlie", "Delta"];
        let mut tokens = Vec::new();
        let mut rxs = Vec::new();
        for w in wallets {
            let (tok, rx) = register_bot(&state, w);
            tokens.push(tok);
            rxs.push(rx);
        }

        // Casual (no buy-in) tournament; join all four as bots.
        let tid = tourney_create(
            State(state.clone()),
            HeaderMap::new(),
            Json(TourneyCreateReq {
                name: "T".into(),
                buy_in: None,
                initial_secs: 60,
                increment_secs: 1,
            }),
        )
        .await
        .expect("create")
        .0
        .tournament_id;
        for i in 0..4 {
            let code = tourney_join(
                State(state.clone()),
                Path(tid),
                bearer(&tokens[i]),
                Json(JoinReq {
                    player: Some(names[i].into()),
                    seat: Some("bot".into()),
                    uci_options: None,
                }),
            )
            .await;
            assert_eq!(code, StatusCode::OK, "join {i}");
        }

        // Start → dispatches round 0 only.
        tourney_start(State(state.clone()), Path(tid), HeaderMap::new())
            .await
            .expect("start");

        let round_games = |round: usize| -> Vec<GameId> {
            state
                .0
                .lobby
                .tournaments
                .lock()
                .get(&tid)
                .unwrap()
                .games
                .iter()
                .filter(|g| g.round == round)
                .map(|g| g.game_id)
                .collect()
        };

        // Round 0: 4 players → 2 concurrent games; each bot got exactly one seat.
        assert_eq!(round_games(0).len(), 2, "round 0 has 2 games");
        for rx in &mut rxs {
            assert!(
                matches!(rx.try_recv(), Ok(ServerToAgent::AssignSeat { .. })),
                "each bot is dispatched one seat in round 0"
            );
            assert!(rx.try_recv().is_err(), "and only one this round");
        }

        // Drive every round through the REAL results_task, which mirrors
        // production: it frees a finished game's bots BEFORE advancing, so the
        // next round can re-claim them. If that freeing regresses (the T1 race),
        // round 1+ pairings forfeit, no real games get created, and the
        // per-round wait below times out — this test is the regression guard.
        tokio::spawn(results_task(state.clone(), results_rx));
        let tx = state.0.results_tx.clone();
        let _ = &mut rxs; // agents keep receiving AssignSeat; we don't assert on it here

        for round in 0..3 {
            // Wait for this round's two real games to be dispatched.
            let mut games = Vec::new();
            for _ in 0..500 {
                games = round_games(round);
                if games.len() == 2 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
            assert_eq!(games.len(), 2, "round {round}: two real games (no spurious forfeits)");
            for gid in games {
                tx.send(GameOutcome {
                    game_id: gid,
                    winner: Some(Color::White),
                    plies: 40,
                    white_showed_up: true,
                    black_showed_up: true,
                })
                .await
                .unwrap();
            }
        }

        // The pool settles after the final round.
        let mut settled = false;
        for _ in 0..500 {
            settled = state
                .0
                .lobby
                .tournaments
                .lock()
                .get(&tid)
                .map(|t| t.status == "settled")
                .unwrap_or(false);
            if settled {
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        assert!(settled, "tournament settled");

        // 6 games total (C(4,2)), all real + decisive → 6 points distributed.
        let t = state.0.lobby.tournaments.lock();
        let t = t.get(&tid).unwrap();
        assert_eq!(t.games.len(), 6, "full round-robin, all real games");
        let total: f64 = t.scores.values().sum();
        assert_eq!(total, 6.0, "6 decisive games distribute 6 points");
    }

    #[tokio::test]
    async fn tournament_forfeits_a_pairing_when_a_bot_is_offline() {
        let (state, _c, _r) = test_state();
        // Two entrants; only one has an online bot. The offline one forfeits.
        let (tok_a, _rx_a) = register_bot(&state, "0xaa11111111111111111111111111111111111111");
        // Bravo authenticates but never connects an agent.
        let tok_b = state
            .0
            .auth
            .mint_session("0xbb22222222222222222222222222222222222222");
        let tid = tourney_create(
            State(state.clone()),
            HeaderMap::new(),
            Json(TourneyCreateReq {
                name: "T".into(),
                buy_in: None,
                initial_secs: 60,
                increment_secs: 1,
            }),
        )
        .await
        .expect("create")
        .0
        .tournament_id;
        // Alpha joins as a bot (online); Bravo tries to join as a bot but is offline → 424.
        assert_eq!(
            tourney_join(
                State(state.clone()),
                Path(tid),
                bearer(&tok_a),
                Json(JoinReq { player: Some("Alpha".into()), seat: Some("bot".into()), uci_options: None }),
            )
            .await,
            StatusCode::OK
        );
        assert_eq!(
            tourney_join(
                State(state.clone()),
                Path(tid),
                bearer(&tok_b),
                Json(JoinReq { player: Some("Bravo".into()), seat: Some("bot".into()), uci_options: None }),
            )
            .await,
            StatusCode::FAILED_DEPENDENCY,
            "offline bot can't join"
        );
        // Bravo joins as a browser entrant instead.
        assert_eq!(
            tourney_join(
                State(state.clone()),
                Path(tid),
                HeaderMap::new(),
                Json(JoinReq { player: Some("Bravo".into()), seat: None, uci_options: None }),
            )
            .await,
            StatusCode::OK
        );
        // Now make Alpha's bot busy so it can't be claimed at dispatch → its
        // single pairing forfeits to Bravo, the round is empty, tournament settles.
        assert!(state.0.agents.claim("0xaa11111111111111111111111111111111111111").is_ok());
        tourney_start(State(state.clone()), Path(tid), HeaderMap::new())
            .await
            .expect("start");
        let t = state.0.lobby.tournaments.lock();
        let t = t.get(&tid).unwrap();
        assert_eq!(t.games.len(), 0, "no game created — the pairing forfeited");
        assert_eq!(t.status, "settled");
        assert_eq!(t.scores.get("Bravo").copied(), Some(1.0), "Bravo wins the forfeit");
    }

    #[tokio::test]
    async fn tournament_rejects_duplicate_casual_name() {
        let (state, _c, _r) = test_state();
        let tid = tourney_create(
            State(state.clone()),
            HeaderMap::new(),
            Json(TourneyCreateReq {
                name: "T".into(),
                buy_in: None,
                initial_secs: 60,
                increment_secs: 1,
            }),
        )
        .await
        .expect("create")
        .0
        .tournament_id;
        let join = |name: &str| {
            tourney_join(
                State(state.clone()),
                Path(tid),
                HeaderMap::new(),
                Json(JoinReq {
                    player: Some(name.to_string()),
                    seat: None,
                    uci_options: None,
                }),
            )
        };
        assert_eq!(join("Alpha").await, StatusCode::OK);
        // Reusing a name must be rejected — otherwise a later joiner (esp. a bot)
        // would hijack the existing entrant's seat/identity.
        assert_eq!(join("Alpha").await, StatusCode::CONFLICT);
        assert_eq!(join("alpha").await, StatusCode::CONFLICT, "case-insensitive");
    }

    #[tokio::test]
    async fn park_bot_vs_bot_dispatches_both_seats() {
        // Covers the third `claim_agent_seat` call site (park_accept) that the
        // gauntlet/tournament tests don't touch.
        let (state, _c, _r) = test_state();
        let wa = "0xaa00000000000000000000000000000000000001";
        let wb = "0xbb00000000000000000000000000000000000002";
        let (tok_a, mut rx_a) = register_bot(&state, wa);
        let (tok_b, mut rx_b) = register_bot(&state, wb);

        // Bot A posts a park offer as a bot.
        let offer_id = park_create(
            State(state.clone()),
            bearer(&tok_a),
            Json(ParkCreateReq {
                stake: None,
                initial_secs: 60,
                increment_secs: 1,
                name: None,
                engine: None,
                seat: Some("bot".into()),
                uci_options: None,
            }),
        )
        .await
        .expect("create")
        .0
        .offer_id;

        // Bot B accepts it as a bot → both seats dispatch to their agents.
        let resp = park_accept(
            State(state.clone()),
            Path(offer_id),
            bearer(&tok_b),
            Some(Json(ParkAcceptReq {
                name: None,
                engine: None,
                seat: Some("bot".into()),
                uci_options: None,
            })),
        )
        .await
        .expect("accept")
        .0;

        // A bot seat keeps its token server-side; the browser spectates.
        assert!(resp.token.is_none(), "bot acceptor gets no launch token");
        assert_eq!(resp.seat, "bot");
        assert!(matches!(rx_a.try_recv(), Ok(ServerToAgent::AssignSeat { .. })), "poster bot seated");
        assert!(matches!(rx_b.try_recv(), Ok(ServerToAgent::AssignSeat { .. })), "acceptor bot seated");
        assert!(state.0.agents.claim(wa).is_err(), "poster busy");
        assert!(state.0.agents.claim(wb).is_err(), "acceptor busy");
    }
}
