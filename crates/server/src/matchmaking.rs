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
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
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
    build_wager, sanitize_label, short_addr, validate_tc, AppState, GameOutcome, Ladder,
    SeatDelivery, SeatMeta, MAX_STAKE,
};

/// Fields larger than this settle via a Merkle root (winners claim individually)
/// instead of a single direct payout transaction.
const ROOT_SETTLE_THRESHOLD: usize = 16;
/// Retries for the onchain pool read at settlement. A transient RPC failure here
/// would otherwise abort settlement with no automatic retry (the schedule is
/// exhausted, so nothing re-runs it), parking the pool until a manual settle or
/// the settle-window lapse into `claimRefund`. Kept small: this runs in the
/// shared results worker, so the total worst-case pause bounds every tournament.
const POOL_READ_RETRIES: usize = 3;
const POOL_READ_RETRY_MS: u64 = 500;
/// How many `open` tournaments a boot will rebuild from Postgres. TOURNEY_TTL
/// evicts them after 24h anyway, and boot shouldn't drag in an unbounded
/// backlog; hitting the cap is logged rather than passed over in silence.
const OPEN_TOURNAMENT_RESTORE_LIMIT: i64 = 500;
/// Hard cap on tournament entrants (bounds the O(n^2) round-robin + pool math).
const MAX_TOURNAMENT_PLAYERS: usize = 128;
/// Smallest entry fee (USDC base units, 6dp — so this is 1 USDC) that lets a
/// POOLED tournament be `Open`. Below it, the organizer must gate admission.
/// See the check in `tourney_create` for why the bar is materiality rather than
/// non-zero: a seat has to cost an attacker something real, because sponsorship
/// means the prize they are chasing is not bounded by what the field paid in.
/// A gated event may charge whatever it likes, including nothing.
const MIN_OPEN_ENTRY_FEE: u128 = 1_000_000;

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
        let GameOutcome {
            game_id,
            winner,
            plies,
            white_showed_up,
            black_showed_up,
        } = *o;
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
                if let Some(g) = t.games.iter_mut().find(|g| g.game_id == game_id) {
                    let (w, b) = (g.white.clone(), g.black.clone());
                    g.result = Some(winner);
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
    AdvanceTournament {
        tid: Uuid,
    },
}

/// Consumes game outcomes and updates mode standings; drives tournament rounds
/// and settles finished tournaments onchain.
///
/// The receiver arrives in an Arc-Mutex because `supervise` re-invokes this on
/// panic, and an owned receiver would die with the first incarnation.
pub async fn results_task(
    state: AppState,
    rx: Arc<tokio::sync::Mutex<mpsc::Receiver<GameOutcome>>>,
) {
    let mut rx = rx.lock().await;
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
            "/tournaments/{id}/invites",
            post(tourney_invites_mint).get(tourney_invites_list),
        )
        .route(
            "/tournaments/{id}/requests",
            post(tourney_request).get(tourney_requests_list),
        )
        .route(
            "/tournaments/{id}/requests/{wallet}",
            post(tourney_request_decide),
        )
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

/// One fair coin per pairing, deciding which of the two seats gets White.
///
/// Park and the queue used to hand colour out by ROLE — the poster of an offer
/// took White and whoever accepted it took Black, and in the queue the player
/// already waiting took White. That is a standing first-move advantage for one
/// side of every repeated matchup: the house bot stands the open offers, so a
/// player who only ever joined them never once had the first move, and the
/// same seat carried the advantage in every staked game between them.
///
/// Draw it BEFORE the wager is built. `build_wager` takes (white, black) and
/// the EIP-712 result the oracle signs is keyed on that pair, so a flip applied
/// any later than the wager would settle the game against the wrong seats.
/// Tournaments do not use this — a round-robin alternates colours on a schedule
/// instead (`round_robin_rounds`), which is stronger than a coin per pairing.
fn coin_flip() -> bool {
    rand::random()
}

/// Order a pair into the `[white, black]` layout every seat-indexed array uses,
/// given whether `a` won the coin.
///
/// Everything about a pairing is carried in parallel — seat metadata, delivery,
/// launch tokens, the colour each client is told, and the wallets the wager is
/// built from — and ALL of it has to flip together. Hand-writing the swap at
/// each site is how one of them ends up inverted, which does not fail loudly:
/// it seats a player on the wrong side, or opens escrow against the wrong two
/// wallets. So the flip lives here, once, and every site calls it.
fn seats<T>(a_is_white: bool, a: T, b: T) -> [T; 2] {
    if a_is_white {
        [a, b]
    } else {
        [b, a]
    }
}

// --------------------------------------------------------------------------
// Park / Patzer
// --------------------------------------------------------------------------

struct ParkOffer {
    poster_addr: Option<String>, // authenticated wallet (wagered or bot seats)
    /// The poster's username, resolved from `poster_addr` at create time — never
    /// a string the client sent. `None` for an anonymous poster, and for a
    /// signed-in one who has not claimed a handle; the lobby falls back to
    /// `poster_addr` in both cases.
    poster_name: Option<String>,
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
    /// Which colour the poster drew, recorded at match time (`coin_flip`).
    /// `None` until then — a poster polling an unmatched offer has no colour
    /// yet, and must not be told one, since posting no longer implies White.
    poster_color: Option<String>,
    /// Who took the offer, recorded at match time. The acceptor learns the
    /// poster's identity from the offer row, but the poster only ever learns
    /// theirs from `GameStart` — which the server withholds until BOTH seats
    /// have readied, too late for a client that wants to name the opponent in
    /// a pre-game confirmation.
    opponent: Option<protocol::OpponentInfo>,
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
    /// Deprecated and ignored. The lobby label is resolved from the poster's
    /// username server-side, because a client-chosen one can name anybody. Kept
    /// on the struct only so an older client's body still deserializes.
    #[allow(dead_code)]
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
    // EVERY offer needs a session, free ones included. Wagered offers and bot
    // seats always did; a free offer used to be postable anonymously, which is
    // now the wrong shape for three reasons. The web app gates the whole lobby
    // (components/SignInGate.tsx), so an anonymous free offer can only come
    // from a script — and it lands in the same "Open challenges" table as
    // everyone else's, rendered as "Anonymous", a row no user of the site could
    // have created. A seat with no wallet records no history and moves no Elo,
    // so it is a game that never happened for one of its two players. And the
    // same-wallet guard keys on `poster_addr`, so a `None` fails it open.
    // Nothing legitimate loses: `chess-client` is wallet-bound by design (no
    // anonymous bots), and the House Bot posts under `HOUSE_WALLET`.
    // Still `Option<String>` rather than `String` — offers rehydrated from
    // before this change may carry `None`, and the lobby renders that.
    let poster_addr = Some(
        state
            .authed_wallet(&headers)
            .ok_or(StatusCode::UNAUTHORIZED)?,
    );

    // Validate the stake NOW, not at accept: an unparseable or absurd stake
    // would otherwise stand in the public lobby, and every join would die with
    // a bare 400 from build_wager while the poster wonders why nobody bites.
    if let Some(s) = &req.stake {
        let stake = s.parse::<U256>().map_err(|_| StatusCode::BAD_REQUEST)?;
        if stake == U256::ZERO || stake > U256::from(MAX_STAKE) {
            return Err(StatusCode::BAD_REQUEST);
        }
    }

    // The offer's public label is SERVER-RESOLVED from the poster's wallet.
    // `req.name` is ignored, and so is the bot's `AgentMeta.name`: that string
    // is the owner's own description of what they run, shown back to them in
    // the bot panel, and it has no business standing as a public identity in
    // the lobby — anyone could type anyone's handle into it. An anonymous
    // poster gets `None`, which the lobby already renders from `poster_addr`.
    let poster_name = match (&poster_addr, &state.0.db) {
        (Some(w), Some(db)) => db.username_for(w).await.ok().flatten(),
        _ => None,
    };
    let mut poster_engine = req.engine.as_deref().and_then(sanitize_label);
    if bot {
        // The bot must be online to post as it; default the ENGINE from its
        // registration so the lobby shows what it actually runs.
        let wallet = poster_addr.as_deref().unwrap_or_default();
        let Some((meta, _busy)) = state.0.agents.view(wallet) else {
            return Err(StatusCode::FAILED_DEPENDENCY); // 424: bot offline
        };
        poster_engine = poster_engine.or(Some(meta.engine));
    }

    // Cap simultaneously-open offers per owner (wallet if known, else IP) so a
    // single actor can't flood the lobby with challenges.
    let owner_key = poster_addr.clone().unwrap_or_else(|| format!("ip:{ip}"));
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
                poster_color: None,
                cancel_key: cancel_key.clone(),
                owner_key,
                opponent: None,
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

async fn park_list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<OfferSummary>>, StatusCode> {
    state.reject_if_rate_limited_polls(&headers)?;
    let park = state.0.lobby.park.lock();
    Ok(Json(
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
    ))
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
    /// The poster's display identity, resolved server-side (declared name,
    /// else shortened wallet, else "anonymous") so the acceptor doesn't have
    /// to re-derive the fallback from the offer row.
    opponent: protocol::OpponentInfo,
}

#[derive(Deserialize, Default)]
struct ParkAcceptReq {
    /// Deprecated and ignored — see `ParkCreateReq::name`. Kept so an older
    /// client's body still deserializes.
    #[allow(dead_code)]
    name: Option<String>,
    /// Optional self-declared engine for the acceptor's seat (unverified).
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
    // Throttle per-IP on the CREATE budget, not the offers one: a successful
    // accept locks escrow onchain and spawns a room actor, which is exactly
    // the cost class that bucket meters (posting an offer commits nothing).
    if state.0.limits.create.check(&client_ip(&headers)).is_some() {
        return Err(StatusCode::TOO_MANY_REQUESTS);
    }
    let acceptor_bot = is_bot_seat(&req.seat);
    // Required, like posting one: both sides of a game need a session. Sitting
    // down anonymously doesn't just lose the game from your history — it also
    // fails the same-wallet check below OPEN, so a poster could accept their
    // own offer. Read before the offer is claimed, so a rejected join doesn't
    // consume it.
    let acceptor_wallet = Some(
        state
            .authed_wallet(&headers)
            .ok_or(StatusCode::UNAUTHORIZED)?,
    );

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
                // Casual offers may be anonymous; when the poster signed in,
                // this is what puts the finished game in their history.
                wallet: offer.poster_addr.clone(),
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

    // Who gets White. Drawn here, above the wager, so the escrow and the
    // signed result are keyed on the seats actually played (see `coin_flip`).
    let poster_white = coin_flip();

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
        let [white, black] = seats(poster_white, &poster, &acceptor);
        match build_wager(white, black, stake) {
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

    // Acceptor identity. `name` is left empty on purpose whenever there IS a
    // wallet: `start_game` resolves that seat's label from its username and
    // never reads this field, so filling it would be dead weight that a future
    // edit could turn back into an impersonation surface. Only a genuinely
    // anonymous acceptor has a label to carry, and there is none to carry here.
    let acceptor_meta = SeatMeta {
        name: None,
        engine: req
            .engine
            .as_deref()
            .and_then(sanitize_label)
            .or_else(|| acceptor_agent_meta.as_ref().map(|m| m.engine.clone())),
        wallet: acceptor_wallet.clone(),
    };

    // start_game creates the room, locks escrow, and DISPATCHES bot seats —
    // and aborts the game (escrow refunded) if an agent vanished, returning
    // Err. On any Err the claims are released and the offer reopens.
    let meta = seats(poster_white, poster_meta, acceptor_meta);
    let delivery = seats(poster_white, poster_delivery, acceptor_delivery);
    // A staked offer is ranked via its wager; a free one is casual.
    let resp = match state
        .start_game(tc, "park", wager, Ladder::Casual, meta, delivery)
        .await
    {
        Ok(r) => r,
        Err(e) => {
            release(&claimed);
            unclaim();
            return Err(e);
        }
    };

    // Unpack the [white, black] response back into poster/acceptor terms. Same
    // helper, read in reverse: `seats` is its own inverse, so the unpacking
    // cannot drift from the packing above.
    let [poster_idx, acceptor_idx] = seats(poster_white, 0, 1);
    let [poster_token, acceptor_token] = seats(poster_white, resp.white_token, resp.black_token);
    let [poster_color, acceptor_color] = seats(poster_white, "white", "black");

    if let Some(offer) = state.0.lobby.park.lock().get_mut(&id) {
        offer.status = "matched".into();
        offer.game_id = Some(resp.game_id);
        // A bot-held seat's token stays server-side — the agent has it.
        offer.poster_token = (!poster_bot).then(|| poster_token.clone());
        offer.poster_color = Some(poster_color.into());
        offer.opponent = Some(resp.players[acceptor_idx].clone());
    }
    Ok(Json(ParkAcceptResp {
        game_id: resp.game_id,
        token: (!acceptor_bot).then_some(acceptor_token),
        color: acceptor_color.into(),
        seat: if acceptor_bot { "bot" } else { "browser" }.into(),
        spectate_path: resp.spectate_path,
        opponent: resp.players[poster_idx].clone(),
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
    /// Who took the offer, once matched. Same identity the room will show, so
    /// the poster can name its opponent in a pre-game confirmation instead of
    /// waiting for `GameStart` (which the server holds until both sides ready).
    #[serde(skip_serializing_if = "Option::is_none")]
    opponent: Option<protocol::OpponentInfo>,
}

async fn park_get(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<ParkGetResp>, StatusCode> {
    state.reject_if_rate_limited_polls(&headers)?;
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
            Ok(Json(ParkGetResp {
                status: o.status.clone(),
                game_id: o.game_id,
                token: if authorized {
                    o.poster_token.clone()
                } else {
                    None
                },
                // The colour the coin actually gave the poster, not a constant:
                // this is the ONLY place a browser poster learns which side it
                // is playing before `GameStart`, and the seat it opens the
                // board on has to be the seat its launch token drives.
                color: o.poster_color.clone().filter(|_| authorized),
                seat: Some(if o.poster_seat_bot { "bot" } else { "browser" }.into()),
                // Same gate as the token above, which for a CASUAL offer means
                // "anyone holding the offer id". That is deliberate, not
                // inherited: the id is an unguessable UUID handed only to the
                // poster, and the value behind it is a display name its owner
                // chose to publish in a public lobby (it is already in
                // GET /park/offers). A wagered offer stays wallet-gated.
                opponent: o.opponent.clone().filter(|_| authorized),
            }))
        }
        None => Ok(Json(ParkGetResp {
            status: "not_found".into(),
            game_id: None,
            token: None,
            color: None,
            seat: None,
            opponent: None,
        })),
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
    /// Deprecated and ignored — see `ParkCreateReq::name`. Kept so an older
    /// client's body still deserializes.
    #[allow(dead_code)]
    name: Option<String>,
    /// Optional self-declared engine (shown to the opponent; unverified).
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
    state.reject_if_rate_limited_create(&headers)?;
    let tc = validate_tc(req.initial_secs, req.increment_secs)?;
    let bot = is_bot_seat(&req.seat);
    // Every tier requires auth, free ones included — see `park_create` for the
    // full reasoning. Short version: the seat (and the agent it dispatches to)
    // is always a wallet's, a seat with no recorded wallet is a game that never
    // reaches its own player's history, and the web app no longer offers this
    // to anyone signed out.
    let addr = Some(
        state
            .authed_wallet(&headers)
            .ok_or(StatusCode::UNAUTHORIZED)?,
    );

    // `name` stays empty: a queued seat is only ever anonymous or wallet-bound,
    // and `start_game` resolves the wallet-bound case from its username. See
    // `park_accept` for why filling it would be dead weight at best.
    let mut my_meta = SeatMeta {
        name: None,
        engine: req.engine.as_deref().and_then(sanitize_label),
        wallet: addr.clone(),
    };
    if bot {
        // The bot must be online to queue as it; default its ENGINE from the
        // registration so the opponent/lobby see what it actually runs.
        let wallet = addr.as_deref().unwrap_or_default();
        let (meta, _busy) = state
            .0
            .agents
            .view(wallet)
            .ok_or(StatusCode::FAILED_DEPENDENCY)?; // 424: bot offline
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

    // Paired. Who gets White is a coin, not "whoever waited longer" — a bot
    // parked in the queue used to take White against every arrival it ever
    // matched (see `coin_flip`).
    let opp_white = coin_flip();
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
        state
            .0
            .lobby
            .queue
            .lock()
            .entry(key)
            .or_default()
            .push_back(my_id);
        return Ok(Json(QueueResp { ticket_id: my_id }));
    }
    if session_stopped(req.session_id) {
        // My own session stopped since I joined (raced the auto-stop): don't
        // open a wagered game — put the opponent back for the next live joiner.
        return Err(requeue_opp_then_fail(StatusCode::CONFLICT));
    }

    let wager = if let Some(stake) = req.stake.clone() {
        // Recovery below is keyed on WHOSE wallet is missing, not on colour, so
        // these stay opponent/me and only the `build_wager` order flips.
        let opp_wallet = match opp_addr.clone() {
            Some(w) => w,
            // Wagered pairing but the opponent has no wallet (shouldn't happen —
            // staked tickets are authed): keep me waiting, drop the bad opponent.
            None => {
                state.0.lobby.tickets.lock().remove(&opp_id);
                state
                    .0
                    .lobby
                    .queue
                    .lock()
                    .entry(key)
                    .or_default()
                    .push_back(my_id);
                return Ok(Json(QueueResp { ticket_id: my_id }));
            }
        };
        let my_wallet = match addr.clone() {
            Some(b) => b,
            None => return Err(requeue_opp_then_fail(StatusCode::UNAUTHORIZED)),
        };
        if opp_wallet.eq_ignore_ascii_case(&my_wallet) {
            return Err(requeue_opp_then_fail(StatusCode::BAD_REQUEST));
        }
        let [white, black] = seats(opp_white, &opp_wallet, &my_wallet);
        match build_wager(white, black, &stake) {
            Ok(w) => Some(w),
            Err(e) => return Err(requeue_opp_then_fail(e)),
        }
    } else {
        None
    };

    // Claim both bots BEFORE creating the game, so we never open a game (or an
    // escrow) whose engine can't show up.
    let mut claimed: Vec<String> = Vec::new();
    let opp_delivery = if opp_bot {
        let w = opp_addr.clone().unwrap_or_default();
        match claim_agent_seat(&state.0.agents, w, opp_uci, &mut claimed) {
            Ok(d) => d,
            // The opponent's bot went offline/busy since it queued: its ticket
            // is stale — drop it and put me back to wait for a fresh opponent.
            Err(_) => {
                state.0.lobby.tickets.lock().remove(&opp_id);
                state
                    .0
                    .lobby
                    .queue
                    .lock()
                    .entry(key)
                    .or_default()
                    .push_back(my_id);
                return Ok(Json(QueueResp { ticket_id: my_id }));
            }
        }
    } else {
        SeatDelivery::Browser
    };
    let my_delivery = if bot {
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
    let meta = seats(opp_white, opp_meta, my_meta);
    let delivery = seats(opp_white, opp_delivery, my_delivery);
    // Staked tiers are ranked via their wager.
    let resp = match state
        .start_game(tc, "gauntlet", wager, Ladder::Casual, meta, delivery)
        .await
    {
        Ok(r) => r,
        Err(e) => {
            release(&claimed);
            return Err(requeue_opp_then_fail(e));
        }
    };

    // Attribute the game's result to any gauntlet sessions involved. The colour
    // here is what the session's seat actually plays — standings are scored
    // against it, so a stale constant would credit the wrong side's result.
    let [opp_color, my_color] = seats(opp_white, Color::White, Color::Black);
    let mut links = Vec::new();
    if let Some(sid) = opp_session {
        links.push((sid, opp_color));
    }
    if let Some(sid) = req.session_id {
        links.push((sid, my_color));
    }
    if !links.is_empty() {
        state
            .0
            .lobby
            .game_to_gauntlet
            .lock()
            .insert(resp.game_id, links);
    }

    // Mark both tickets matched. A bot-held seat's token stays server-side (the
    // agent has it); the browser spectates.
    let [opp_token, my_token] = seats(opp_white, resp.white_token, resp.black_token);
    let [opp_side, my_side] = seats(opp_white, "white", "black");
    let mut tickets = state.0.lobby.tickets.lock();
    if let Some(t) = tickets.get_mut(&opp_id) {
        t.status = "matched".into();
        t.game_id = Some(resp.game_id);
        t.token = (!opp_bot).then_some(opp_token);
        t.color = Some(opp_side.into());
    }
    if let Some(t) = tickets.get_mut(&my_id) {
        t.status = "matched".into();
        t.game_id = Some(resp.game_id);
        t.token = (!bot).then_some(my_token);
        t.color = Some(my_side.into());
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

/// The ticket id is deliberately the ONLY credential here — a v4 UUID handed
/// over TLS to the joiner and nobody else, i.e. a capability. park_get grew a
/// wallet gate on top of that; this must NOT copy it: shipped native clients
/// (chess-client ≤ v0.1.x run_gauntlet) poll this route without a bearer, so a
/// wallet gate would filter their launch token and reap their STAKED seats as
/// forfeits. Revisit only once authenticated-poll clients are the installed base.
async fn queue_get(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<TicketResp>, StatusCode> {
    state.reject_if_rate_limited_polls(&headers)?;
    let tickets = state.0.lobby.tickets.lock();
    Ok(match tickets.get(&id) {
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
    })
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
    state.reject_if_rate_limited_create(&headers)?;
    validate_tc(req.initial_secs, req.increment_secs)?;
    // Auth for every gauntlet, staked or not — see `park_create`. A free
    // gauntlet is a run of real games against real opponents; only its stake is
    // absent, not its consequences.
    let addr = Some(
        state
            .authed_wallet(&headers)
            .ok_or(StatusCode::UNAUTHORIZED)?,
    );
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
    headers: HeaderMap,
) -> Result<Json<GauntletView>, StatusCode> {
    state.reject_if_rate_limited_polls(&headers)?;
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
    /// How the pool is divided among the final standings. Creator-chosen, fixed
    /// at creation, persisted.
    payout: PayoutSpec,
    /// Who may join. See `Admission`.
    admission: Admission,
    /// Single-use invite codes → the entrant that used one (`None` while
    /// unused). Not the `Auth` link-code machinery: those are wallet-bound at
    /// mint, globally keyed and TTL'd, where these belong to one tournament,
    /// are claimed by whoever presents them, and have to survive a restart with
    /// it.
    invites: HashMap<String, Option<String>>,
    /// Lowercased wallet → the organizer's decision. Keyed on the wallet even
    /// for a casual tournament, whose entrant id is a self-chosen display name:
    /// approving a name would approve a string anyone else could also type.
    approvals: HashMap<String, ApprovalState>,
    /// Last known onchain pool, in USDC base units. `None` until first read.
    ///
    /// Not derivable any more. `buy_in × entrants` was the pool only while
    /// entries were the sole way to fund one; a sponsor moves USDC in with a
    /// browser transaction this server never sees, so the figure has to be
    /// polled (`pool_refresh_task`). Display only — settlement re-reads the
    /// chain itself (`distribute_pool`), because paying out a stale number is
    /// the one place being behind actually costs someone money.
    pool: Option<u128>,
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
    /// Pairings awarded without a game (a bot seat that was offline at its
    /// round's dispatch). They score exactly like a played game, so a standings
    /// table that omitted them would not add up — every point has to be
    /// traceable to a row the viewer can see.
    forfeits: Vec<Forfeit>,
    /// Entrants whose seat is played by their connected agent (player id ->
    /// dispatch info). In-memory only — a restart abandons in-flight tournaments.
    entrant_bots: HashMap<String, BotEntry>,
    /// Self-declared engine per entrant (player id -> sanitized label).
    entrant_engines: HashMap<String, String>,
    /// Signed-in wallet per entrant (player id -> lowercased wallet). This is
    /// what puts a CASUAL tournament's finished games in the entrant's history
    /// and moves their casual Elo — a buy-in entrant's id already IS a wallet,
    /// and a bot's rides its BotEntry. Persisted (migration 0016): games
    /// dispatched after a restart must stay attributed, unlike the display-only
    /// entrant_engines above.
    entrant_wallets: HashMap<String, String>,
    /// For a root-settled (large) tournament: the payout leaves, so the server
    /// can serve Merkle proofs to claimers. (addr, amount in base units)
    payout_leaves: Vec<(String, u128)>,
    created_at: Instant,
}

/// Who may join a tournament. Chosen by the creator, fixed at creation.
///
/// Only one of the three is enforced by the chain: a **nominal entry fee**,
/// which is just `buy_in` and needs nothing here — N fake entrants cost N × fee,
/// and the fee lands in the pool they were trying to farm. The two below are
/// server policy, so they live in this single-node process's memory (and its
/// durable row); they are a door, not a vault.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Admission {
    /// Anyone may join.
    #[default]
    Open,
    /// Must present an unused single-use code the organizer minted.
    Invite,
    /// Must be a signed-in wallet the organizer has approved.
    Approval,
}

/// Where a wallet stands with an approval-gated tournament.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ApprovalState {
    Pending,
    Approved,
    Rejected,
}

/// Most codes an organizer may have outstanding on one tournament. Bounds the
/// map that rides on every persist and every rehydrate.
const MAX_INVITE_CODES: usize = 256;
/// Most pending/decided requests one tournament will record. Its own constant
/// rather than borrowing the invite cap: they bound different maps, filled by
/// different people (the organizer mints codes; anyone can ask to join), and a
/// shared name would make a future change to one silently move the other.
const MAX_JOIN_REQUESTS: usize = 256;

/// Dispatch info for a bot entrant (its seat is played by its connected agent).
#[derive(Clone)]
struct BotEntry {
    wallet: String,
    uci_options: Vec<(String, String)>,
}

/// A pairing decided without a game being played.
#[derive(Clone)]
struct Forfeit {
    white: String,
    black: String,
    round: usize,
    /// Who was awarded the point; `None` when neither side could play (a draw).
    winner: Option<Color>,
}

#[derive(Clone, Serialize)]
struct TourneyGame {
    game_id: GameId,
    white: String,
    black: String,
    /// 0-based round this game belongs to.
    round: usize,
    /// Outcome once the game finishes: `Some(None)` is a draw, `None` means
    /// still in progress. Recorded here (not just as a score delta) so a client
    /// can render a crosstable instead of a bare point total.
    #[serde(skip)]
    result: Option<Option<Color>>,
    // Launch tokens are seat capabilities — never serialize them into the public
    // tournament view. Each entrant fetches only its own via GET
    // /tournaments/{id}/my-games (authenticated). Leaking them lets anyone play
    // (and throw) any game, steering the onchain pool payout.
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
    for r in 0..m - 1 {
        let mut round = Vec::with_capacity(m / 2);
        for i in 0..m / 2 {
            let (a, b) = (arr[i], arr[m - 1 - i]);
            // Colour allocation. The rotation already alternates colours for
            // every seat except the pivot arr[0], which never moves — so taking
            // the left element as White unconditionally handed entrant 0 the
            // white pieces in every single round, a standing first-move
            // advantage in an event that pays out a real pool. Flipping only
            // the pivot's own pairing on odd rounds is the standard fix and
            // keeps every entrant within one white of even. (Flipping the whole
            // round instead just moves the problem onto the pivot's opponent.)
            let (white, black) = if i == 0 && r % 2 == 1 { (b, a) } else { (a, b) };
            // Skip any pairing that involves the bye seat (index == n).
            if white < n && black < n {
                round.push((white, black));
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
    /// How to divide the pool: basis points per finishing place, best first
    /// (`{"bps":[5000,3000,2000]}`). Omitted = the default 65/25/10.
    payout: Option<PayoutSpec>,
    /// Who may join: `open` (default), `invite`, or `approval`.
    admission: Option<Admission>,
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
    // Drain: reject before opening an onchain pool (burns oracle gas) for a
    // tournament that couldn't be started (tourney_start is also drained).
    state.reject_if_draining()?;
    state.reject_if_rate_limited_create(&headers)?;
    validate_tc(req.initial_secs, req.increment_secs)?;
    // The name flows raw into the lobby view every client polls, Postgres, and
    // the logs — the same reasons every other user-supplied label here goes
    // through sanitize_label (control chars out, length capped).
    let name = sanitize_label(&req.name).ok_or(StatusCode::BAD_REQUEST)?;
    // Validate the prize structure BEFORE anything commits — in particular
    // before a buy-in tournament opens its onchain pool below. A structure
    // rejected at settlement time would already have locked everyone's entry.
    let payout = req.payout.unwrap_or_default();
    if let Err(why) = payout.validate() {
        tracing::warn!("rejecting tournament payout structure: {why}");
        return Err(StatusCode::BAD_REQUEST);
    }
    // A gated tournament needs someone who can open the gate. Both invite
    // minting and approval are organizer-only, so an anonymously-created one
    // would be a door nobody can ever unlock — every join refused, forever.
    let admission = req.admission.unwrap_or_default();
    if admission != Admission::Open && state.authed_wallet(&headers).is_none() {
        return Err(StatusCode::UNAUTHORIZED);
    }
    // A pooled event whose entry costs ~nothing is drainable under Open
    // admission: the pool can be topped up by sponsors (`sponsorTournament` is
    // permissionless and works on any pooled tournament), so what an attacker
    // can win is unbounded while what a seat costs them is not. They field
    // throwaway entrants, take places in the split, and the entry fees they paid
    // — which for a buy-in event are the thing that funds what Sybils take —
    // don't come close to covering it. Require a gate (invite or approval) so
    // the organizer decides who can be paid.
    //
    // The bar is MATERIALITY, not merely non-zero. A 1-base-unit entry
    // (0.000001 USDC) is free in every way that matters and would sail through a
    // `== 0` test, while additionally billing the oracle a `enterTournament`
    // transaction per Sybil and — because `tournament_ladder` calls any paid
    // event ranked — moving the public leaderboard. A CASUAL event
    // (`buy_in: null`, no pool) is unaffected: there is nothing to drain.
    if has_pool(req.buy_in.as_deref())
        && entry_fee(req.buy_in.as_deref()) < MIN_OPEN_ENTRY_FEE
        && admission == Admission::Open
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    // Global ceiling, casual included: every tournament in the map is walked by
    // every `GET /tournaments` under the lobby mutex, and a casual one costs
    // nothing to create and lives a day — unbounded, the map is a DoS surface.
    {
        let ts = state.0.lobby.tournaments.lock();
        if ts.len() >= state.0.limits.max_lobby_tournaments {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
    }
    let id = Uuid::new_v4();
    // The creating wallet (if authenticated) — only they may start it later.
    let organizer = state.authed_wallet(&headers);

    // A buy-in tournament opens its onchain pool now (fail-closed). Require an
    // authenticated caller so an anonymous request can't burn oracle gas.
    if let Some(buy_in_str) = &req.buy_in {
        let creator = state
            .authed_wallet(&headers)
            .ok_or(StatusCode::UNAUTHORIZED)?;
        // Cap the number of not-yet-finished buy-in tournaments this wallet may
        // have open at once. Each one opens an oracle-gas-funded pool while the
        // organizer locks nothing until someone joins, so without this a single
        // authed wallet could drain oracle ETH by looping creation. Best-effort:
        // the count isn't atomic with the insert below (the pool open awaits in
        // between), so a concurrent burst can overshoot — bounded by the per-IP
        // create throttle, which is the primary rate control here.
        {
            let ts = state.0.lobby.tournaments.lock();
            let open = ts
                .values()
                .filter(|t| {
                    t.buy_in.is_some()
                        && !matches!(t.status.as_str(), "settled" | "complete" | "abandoned")
                        && t.organizer
                            .as_deref()
                            .is_some_and(|o| o.eq_ignore_ascii_case(&creator))
                })
                .count();
            if open >= state.0.limits.max_open_tournaments {
                return Err(StatusCode::TOO_MANY_REQUESTS);
            }
        }
        // Zero IS allowed, and it is what makes a free-entry sponsored event:
        // the pool exists onchain, entrants pay nothing into it, and sponsors
        // fund it with `sponsorTournament` from their own bankroll. A casual
        // tournament (no pool at all) is `buy_in: null`, not `"0"`.
        let buy_in = buy_in_str
            .parse::<U256>()
            .map_err(|_| StatusCode::BAD_REQUEST)?;
        if buy_in > U256::from(MAX_STAKE) {
            return Err(StatusCode::BAD_REQUEST);
        }
        if !state.0.settlement.is_onchain() {
            return Err(StatusCode::SERVICE_UNAVAILABLE);
        }
        // Skin in the game before we spend oracle gas. `open_tournament` is an
        // oracle-PAID transaction while the organizer locks nothing until
        // someone joins, and a SIWE session costs nothing to mint — so the
        // per-wallet cap above doesn't actually bind an attacker, only the
        // per-IP throttle does. Requiring a funded escrow balance ties the cost
        // to something that can't be minted: the organizer must at least be
        // able to pay their own buy-in.
        //
        // Fails CLOSED on a real zero balance, OPEN on an RPC error (`None`) —
        // a flaky node must not lock legitimate organizers out of the feature.
        //
        // `max(1)` is what keeps this gate from evaporating on a FREE-entry
        // tournament. Sponsored events have a zero buy-in, and `balance < 0` is
        // never true, so the plain comparison would wave every zero-balance
        // creator straight through to an oracle-paid `openTournament` — exactly
        // the hole this check was added to close, reopened by a feature that
        // arrived after it. Requiring any deposit at all still ties the cost to
        // something that can't be minted for free.
        let creator_addr = creator
            .parse::<Address>()
            .map_err(|_| StatusCode::BAD_REQUEST)?;
        if let Some(balance) = state.0.settlement.bankroll_of(creator_addr).await {
            if balance < buy_in.max(U256::from(1)) {
                return Err(StatusCode::PAYMENT_REQUIRED); // 402
            }
        }
        state
            .0
            .settlement
            .open_tournament(id, buy_in)
            .await
            .map_err(|_| StatusCode::BAD_GATEWAY)?;
    }

    let has_buy_in = req.buy_in.is_some();
    state.0.lobby.tournaments.lock().insert(
        id,
        Tournament {
            name,
            buy_in: req.buy_in,
            payout,
            admission,
            invites: HashMap::new(),
            approvals: HashMap::new(),
            pool: None,
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
            forfeits: Vec::new(),
            entrant_bots: HashMap::new(),
            entrant_engines: HashMap::new(),
            entrant_wallets: HashMap::new(),
            payout_leaves: Vec::new(),
            created_at: Instant::now(),
        },
    );
    // Persist so a restart can recover this tournament (see recover_tournaments).
    // Best-effort at creation: no money is locked yet (the organizer stakes
    // nothing), and the first successful join re-writes the whole snapshot. But
    // a buy-in pool IS open onchain, so say so out loud rather than silently.
    if persist_tournament(&state, id).await.is_err() && has_buy_in {
        crate::alert::fire(format!(
            "⚠️ OpenChess: buy-in tournament {id} opened its onchain pool but could not \
             be persisted; a restart before the first successful join loses it from the \
             lobby while the pool stays open."
        ));
    }
    Ok(Json(IdResp { tournament_id: id }))
}

/// Serialize a tournament's bot entrants for the durable row, so a rehydrated
/// tournament still knows which seats its agents play (and with what options).
fn bots_json(entrant_bots: &HashMap<String, BotEntry>) -> serde_json::Value {
    json!(entrant_bots
        .iter()
        .map(|(player, be)| (
            player.clone(),
            json!({ "wallet": be.wallet, "uci_options": be.uci_options })
        ))
        .collect::<serde_json::Map<_, _>>())
}

/// Inverse of `bots_json`.
fn bots_from_json(v: &serde_json::Value) -> HashMap<String, BotEntry> {
    v.as_object()
        .map(|m| {
            m.iter()
                .filter_map(|(player, be)| {
                    let wallet = be.get("wallet")?.as_str()?.to_string();
                    let uci_options = be
                        .get("uci_options")
                        .and_then(|o| o.as_array())
                        .map(|a| {
                            a.iter()
                                .filter_map(|kv| {
                                    Some((
                                        kv.get(0)?.as_str()?.to_string(),
                                        kv.get(1)?.as_str()?.to_string(),
                                    ))
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    Some((
                        player.clone(),
                        BotEntry {
                            wallet,
                            uci_options,
                        },
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Re-persist a tournament's row from its in-memory state (players + status).
/// Snapshot a tournament into Postgres so a restart can recover it. `Err`
/// means the WRITE failed and the durable row now disagrees with memory — a
/// caller that just locked money onchain must surface that, because a restart
/// would rehydrate the tournament WITHOUT the entrant while their buy-in stays
/// locked (`recover_tournaments`). No DB configured is `Ok`: nothing to
/// disagree with.
async fn persist_tournament(state: &AppState, tid: Uuid) -> Result<(), ()> {
    let Some(db) = &state.0.db else { return Ok(()) };
    let snap = {
        let ts = state.0.lobby.tournaments.lock();
        ts.get(&tid).map(|t| {
            (
                t.name.clone(),
                t.buy_in.clone(),
                t.organizer.clone(),
                t.initial_secs as i64,
                t.increment_secs as i64,
                t.status.clone(),
                serde_json::to_value(&t.players).unwrap_or_else(|_| json!([])),
                bots_json(&t.entrant_bots),
                serde_json::to_value(&t.entrant_wallets).unwrap_or_else(|_| json!({})),
                serde_json::to_value(&t.entrant_engines).unwrap_or_else(|_| json!({})),
                serde_json::to_value(&t.payout).unwrap_or_else(|_| json!({})),
                serde_json::to_value(t.admission)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string))
                    .unwrap_or_else(|| "open".into()),
                serde_json::to_value(&t.invites).unwrap_or_else(|_| json!({})),
                serde_json::to_value(&t.approvals).unwrap_or_else(|_| json!({})),
            )
        })
    };
    if let Some((
        name,
        buy_in,
        organizer,
        init,
        inc,
        status,
        players,
        bots,
        wallets,
        engines,
        payout,
        admission,
        invites,
        approvals,
    )) = snap
    {
        db.upsert_tournament(
            tid,
            &name,
            buy_in.as_deref(),
            organizer.as_deref(),
            init,
            inc,
            &status,
            &players,
            &bots,
            &wallets,
            &engines,
            &payout,
            &admission,
            &invites,
            &approvals,
        )
        .await
        .map_err(|e| {
            tracing::error!(tournament = %tid, "tournament persist failed: {e}");
        })?;
    }
    Ok(())
}

#[derive(Deserialize)]
struct JoinReq {
    /// "bot" seats the entrant's connected agent for all of its games.
    seat: Option<String>,
    /// UCI option overrides for a bot entrant (applied per game).
    uci_options: Option<HashMap<String, String>>,
    /// Self-declared engine for a BROWSER entrant. Without it a browser seat in
    /// a tournament declared nothing, so its games recorded no engine while the
    /// same browser's park games did.
    engine: Option<String>,
    /// Single-use code, for an `invite`-gated tournament.
    invite: Option<String>,
}

/// Echoes back the entrant id the server actually recorded. A casual display
/// name is sanitized (control chars stripped, capped at 48 chars) before it
/// becomes the entrant's identity, so a client that assumed its own string was
/// stored could end up looking up an entrant that doesn't exist — no games, no
/// standings row, no way back in.
#[derive(Serialize)]
struct JoinResp {
    player: String,
}

/// Enforce the tournament's admission policy, then join.
///
/// **The gate runs before the money**, always, and that ordering is the whole
/// design: there is no onchain path to return a rejected applicant's entry
/// before the settle timeout, so anyone who paid first and was refused second
/// would have USDC locked in a tournament they are not in — the exact failure
/// `tourney_join_inner` already fires a `🚨` alert for when a buy-in lands after
/// a start. So approval and invite are settled here, above `enter_tournament`.
async fn tourney_join(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(req): Json<JoinReq>,
) -> Result<Json<JoinResp>, StatusCode> {
    // Guard BEFORE the admission gate, not after. The invite path below reserves
    // a code under the lobby lock and — on every outcome, including failure —
    // writes the tournament's whole snapshot back to Postgres. `tourney_join_inner`
    // is where the drain check and the throttle used to live, which is after all
    // of that: one valid unused invite code was then an unlimited lever for
    // lock-taking and full-row upserts, since the code is handed back each time.
    // `matchmaking::routes()` carries no `route_layer`, so this handler is the
    // only place that can stop it. Charged once here rather than in both, so a
    // single join still costs a single token.
    if state.maintenance_on() {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    state.reject_if_rate_limited_create(&headers)?;
    let (admission, already_in) = {
        let ts = state.0.lobby.tournaments.lock();
        let t = ts.get(&id).ok_or(StatusCode::NOT_FOUND)?;
        // Someone already in the field re-joining (the retry path for a join
        // that 500'd on its durable write) must not burn a second invite code.
        let me = state.authed_wallet(&headers);
        let already = me
            .as_deref()
            .is_some_and(|w| t.players.iter().any(|p| p.eq_ignore_ascii_case(w)));
        (t.admission, already)
    };

    let mut claimed_code: Option<String> = None;
    if !already_in {
        match admission {
            Admission::Open => {}
            Admission::Approval => {
                // Keyed on the wallet, so this needs one — including for a
                // casual tournament, whose entrant id is a display name anyone
                // could type.
                let wallet = state
                    .authed_wallet(&headers)
                    .ok_or(StatusCode::UNAUTHORIZED)?
                    .to_lowercase();
                let ts = state.0.lobby.tournaments.lock();
                let t = ts.get(&id).ok_or(StatusCode::NOT_FOUND)?;
                // One status for every not-approved case — pending, declined,
                // never asked. Deliberately NOT a 2xx for "pending": `fetch`
                // treats 202 as success, so a client checking `r.ok` would sail
                // past it and tell the applicant they had joined. Which case it
                // is comes from `my_admission` on the detail view, where the
                // client can word it properly.
                if t.approvals.get(&wallet) != Some(&ApprovalState::Approved) {
                    return Err(StatusCode::FORBIDDEN);
                }
            }
            Admission::Invite => {
                let code = req.invite.clone().ok_or(StatusCode::FORBIDDEN)?;
                let mut ts = state.0.lobby.tournaments.lock();
                let t = ts.get_mut(&id).ok_or(StatusCode::NOT_FOUND)?;
                // Reserved under the lock rather than checked-then-used, so two
                // joins racing one code can't both pass. Released below if the
                // join then fails for any reason.
                match t.invites.get_mut(&code) {
                    Some(slot @ None) => *slot = Some(String::new()),
                    _ => return Err(StatusCode::FORBIDDEN), // unknown or already used
                }
                claimed_code = Some(code);
            }
        }
    }

    let result = tourney_join_inner(state.clone(), id, headers, req).await;

    if let Some(code) = claimed_code {
        {
            let mut ts = state.0.lobby.tournaments.lock();
            if let Some(t) = ts.get_mut(&id) {
                if let Some(slot) = t.invites.get_mut(&code) {
                    *slot = match &result {
                        // Record who actually used it, now that they're seated.
                        Ok(Json(resp)) => Some(resp.player.clone()),
                        // The join failed after the reservation — hand the code
                        // back rather than burning it on a seat nobody got.
                        Err(_) => None,
                    };
                }
            }
        }
        // Persist the code's FINAL state. The inner join persists mid-flight,
        // while the code still holds its placeholder reservation, so without
        // this a restart would leave a spent code showing no entrant and a
        // handed-back one still spent.
        let _ = persist_tournament(&state, id).await;
    }
    result
}

async fn tourney_join_inner(
    state: AppState,
    id: Uuid,
    headers: HeaderMap,
    req: JoinReq,
) -> Result<Json<JoinResp>, StatusCode> {
    // Drain: reject before locking a buy-in onchain for a tournament that
    // couldn't be started. Kept as a backstop even though `tourney_join` (this
    // function's only caller) already checked — a money path should not depend on
    // its caller for fail-closed behaviour. The THROTTLE is deliberately not
    // repeated here: it is charged once, in the caller, above the invite
    // reservation that would otherwise happen before it.
    if state.maintenance_on() {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
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
            None => return Err(StatusCode::NOT_FOUND),
        }
    };
    if status != "open" {
        return Err(StatusCode::CONFLICT);
    }
    if full {
        return Err(StatusCode::CONFLICT); // entrant cap reached
    }

    let bot = is_bot_seat(&req.seat);
    // Buy-in tournament: entrant is the authenticated wallet; lock onchain.
    if let Some(buy_in_str) = buy_in {
        let wallet = state
            .authed_wallet(&headers)
            .ok_or(StatusCode::UNAUTHORIZED)?;
        // A bot entrant must be online BEFORE we lock the buy-in onchain — never
        // stake USDC for an engine that can't show up.
        if bot && state.0.agents.view(&wallet).is_none() {
            return Err(StatusCode::FAILED_DEPENDENCY); // 424: bot offline
        }
        // Already entered? (avoid a duplicate onchain entry). Re-persist before
        // answering: this is the retry path for a join that 500'd on the
        // durable write, and an early return without the write would leave that
        // hole open forever.
        let already = {
            let t = state.0.lobby.tournaments.lock();
            t.get(&id)
                .is_some_and(|t| t.players.iter().any(|p| p.eq_ignore_ascii_case(&wallet)))
        };
        if already {
            if persist_tournament(&state, id).await.is_err() {
                return Err(StatusCode::INTERNAL_SERVER_ERROR);
            }
            return Ok(Json(JoinResp { player: wallet }));
        }
        let (addr, buy_in) = match (wallet.parse::<Address>(), buy_in_str.parse::<U256>()) {
            (Ok(a), Ok(b)) => (a, b),
            _ => return Err(StatusCode::BAD_REQUEST),
        };
        // A free entry moves no money, so don't spend an oracle transaction
        // recording it. The only onchain consumer of `tournamentEntered` is
        // `claimRefund`, which has nothing to give back at a zero buy-in (and
        // now refuses outright) — payouts are by signed list or Merkle root and
        // need no prior entry. So a free sponsored tournament costs the oracle
        // exactly two transactions, `openTournament` and settle, whatever the
        // size of the field.
        if buy_in > U256::ZERO && state.0.settlement.enter_tournament(id, addr).await.is_err() {
            return Err(StatusCode::BAD_GATEWAY);
        }
        {
            let mut t = state.0.lobby.tournaments.lock();
            // Re-check under the lock: the join awaited an onchain tx, and the
            // organizer can start (or the sweep can close) the tournament in
            // that gap. The buy-in is already locked; seating the wallet anyway
            // would enter a player the schedule doesn't know, who finishes on
            // zero games and gets paid nothing. Refuse loudly instead — the
            // entrant's funds need a manual return (or the contract's
            // claimRefund once the settle window lapses), and the operator has
            // to hear about it now, not from a support ticket.
            // The player-cap re-check rides the same guard: `full` was read
            // before the await, and concurrent joins past MAX_TOURNAMENT_PLAYERS
            // would break the O(n²) bounds the round-robin math relies on.
            match t.get_mut(&id) {
                Some(t) if t.status == "open" && t.players.len() < MAX_TOURNAMENT_PLAYERS => {
                    if !t.players.iter().any(|p| p.eq_ignore_ascii_case(&wallet)) {
                        t.players.push(wallet.clone());
                    }
                    if let Some(e) = req.engine.as_deref().and_then(sanitize_label) {
                        t.entrant_engines.insert(wallet.clone(), e);
                    }
                    if bot {
                        t.entrant_bots.insert(
                            wallet.clone(),
                            BotEntry {
                                wallet: wallet.clone(),
                                uci_options: clean_uci_options(req.uci_options),
                            },
                        );
                    }
                }
                _ => {
                    drop(t);
                    tracing::error!(tournament = %id, wallet = %wallet, "entry landed after start/close/fill; entrant NOT seated");
                    // Only an alert when money is actually stuck. A free entry
                    // that lost this race cost the entrant nothing, and paging
                    // an operator for it would train them to ignore the alert
                    // that matters.
                    if buy_in > U256::ZERO {
                        crate::alert::fire(format!(
                            "🚨 OpenChess: wallet {wallet} paid a buy-in to tournament {id} that \
                             started, closed, or filled during the join. They are NOT in the \
                             schedule; their entry needs a manual return (or claimRefund after \
                             the settle timeout)."
                        ));
                    }
                    return Err(StatusCode::CONFLICT);
                }
            }
        }
        // The wallet's money is locked onchain; if the durable row can't record
        // them, a restart recovers this tournament WITHOUT them. Fail the join
        // (memory keeps them seated, and a retry re-persists) rather than
        // shrugging — this is a money path, and money paths fail closed.
        if persist_tournament(&state, id).await.is_err() {
            if buy_in > U256::ZERO {
                crate::alert::fire(format!(
                    "🚨 OpenChess: could not persist tournament {id} after wallet {wallet} \
                     entered onchain. A restart before a successful persist rehydrates the \
                     tournament without them while their buy-in stays locked."
                ));
            }
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
        Ok(Json(JoinResp { player: wallet }))
    } else {
        // Casual tournament: the entrant IS the authenticated wallet, exactly as
        // in the buy-in branch above.
        //
        // It used to be a display name the client typed, with the session merely
        // recorded alongside it in `entrant_wallets`. That was two identity
        // models for one table, and the weaker one was the client's: an entrant
        // could type any handle, including somebody else's, and the standings
        // printed it. It is the same hole `seat_info` closes for a board seat
        // (see crates/server/src/username.rs), and it is closed the same way —
        // the server resolves the label from the wallet, and no request body can
        // name a person. Guests can no longer enter a tournament; that is
        // deliberate, and matches the web app, which now gates the whole page.
        let wallet = state
            .authed_wallet(&headers)
            .ok_or(StatusCode::UNAUTHORIZED)?;
        // A bot entrant is wallet-bound (the agent is), so it also needs to be
        // online, even though the tournament itself is free.
        if bot && state.0.agents.view(&wallet).is_none() {
            return Err(StatusCode::FAILED_DEPENDENCY); // 424: bot offline
        }
        {
            let mut t = state.0.lobby.tournaments.lock();
            if let Some(t) = t.get_mut(&id) {
                // Idempotent, like the buy-in path: re-joining is the retry for
                // a join whose durable write failed, and it must not 409.
                if !t.players.iter().any(|p| p.eq_ignore_ascii_case(&wallet)) {
                    // Re-checked under the lock (the pre-await `full` read can
                    // race concurrent joins past the cap the pairing math relies
                    // on).
                    if t.players.len() >= MAX_TOURNAMENT_PLAYERS {
                        return Err(StatusCode::CONFLICT);
                    }
                    t.players.push(wallet.clone());
                }
                if let Some(e) = req.engine.as_deref().and_then(sanitize_label) {
                    t.entrant_engines.insert(wallet.clone(), e);
                }
                // The `else` is load-bearing now that re-joining is idempotent:
                // without it, a wallet that entered with its bot and then
                // re-entered from the browser would keep the binding, so every
                // pairing still dispatches to the agent — the browser sits at a
                // board it is never asked to play, and an agent that is offline
                // at dispatch forfeits the round. Joining is how you choose
                // which plays your seat, so the last join has to win both ways.
                if bot {
                    t.entrant_bots.insert(
                        wallet.clone(),
                        BotEntry {
                            wallet: wallet.clone(),
                            uci_options: clean_uci_options(req.uci_options),
                        },
                    );
                } else {
                    t.entrant_bots.remove(&wallet);
                }
                // Deliberately NOT written: `entrant_wallets` maps a nickname id
                // to its wallet, and this id already IS one (`is_wallet_id`), so
                // `entrant_wallet` resolves it without the detour. The map stays
                // on Tournament to rehydrate name-keyed entrants persisted
                // before this change.
            }
        }
        // Casual: no money locked, so a failed persist costs at worst a lobby
        // entry on restart — best-effort is fine here.
        let _ = persist_tournament(&state, id).await;
        Ok(Json(JoinResp { player: wallet }))
    }
}

// --------------------------------------------------------------------------
// Admission control (organizer-only)
// --------------------------------------------------------------------------

/// Is this caller the tournament's organizer? Every gate-management route is
/// theirs alone — a tournament whose door anyone could open is not gated.
fn is_organizer(t: &Tournament, caller: Option<&str>) -> bool {
    matches!((&t.organizer, caller), (Some(org), Some(c)) if org.eq_ignore_ascii_case(c))
}

#[derive(Deserialize)]
struct MintInvitesReq {
    #[serde(default = "one")]
    count: usize,
}
fn one() -> usize {
    1
}

#[derive(Serialize)]
struct InviteRow {
    code: String,
    /// The entrant that used it; absent while the code is still good.
    used_by: Option<String>,
}

/// Mint single-use invite codes. Organizer-only.
async fn tourney_invites_mint(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
    Json(req): Json<MintInvitesReq>,
) -> Result<Json<Vec<InviteRow>>, StatusCode> {
    state.reject_if_rate_limited_create(&headers)?;
    let caller = state.authed_wallet(&headers);
    // Scoped so the (non-Send) lobby guard is provably gone before the persist
    // below awaits.
    let minted: Vec<String> = {
        let mut ts = state.0.lobby.tournaments.lock();
        let t = ts.get_mut(&id).ok_or(StatusCode::NOT_FOUND)?;
        if !is_organizer(t, caller.as_deref()) {
            return Err(StatusCode::FORBIDDEN);
        }
        if req.count == 0 || req.count > MAX_INVITE_CODES {
            return Err(StatusCode::BAD_REQUEST);
        }
        if t.invites.len() + req.count > MAX_INVITE_CODES {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        let minted: Vec<String> = (0..req.count)
            .map(|_| Uuid::new_v4().simple().to_string())
            .collect();
        for code in &minted {
            t.invites.insert(code.clone(), None);
        }
        minted
    };
    // Best-effort: a code that isn't persisted stops working after a restart,
    // which fails CLOSED (the holder is refused, nobody gets in wrongly).
    let _ = persist_tournament(&state, id).await;
    Ok(Json(
        minted
            .into_iter()
            .map(|code| InviteRow {
                code,
                used_by: None,
            })
            .collect(),
    ))
}

/// Every code and whether it has been spent. Organizer-only — the unused codes
/// ARE the credentials, so this must never be public.
async fn tourney_invites_list(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Vec<InviteRow>>, StatusCode> {
    state.reject_if_rate_limited_polls(&headers)?;
    let caller = state.authed_wallet(&headers);
    let ts = state.0.lobby.tournaments.lock();
    let t = ts.get(&id).ok_or(StatusCode::NOT_FOUND)?;
    if !is_organizer(t, caller.as_deref()) {
        return Err(StatusCode::FORBIDDEN);
    }
    let mut rows: Vec<InviteRow> = t
        .invites
        .iter()
        .map(|(code, used)| InviteRow {
            code: code.clone(),
            // The empty string is the in-flight reservation `tourney_join`
            // writes while a join is running; it isn't an entrant yet.
            used_by: used.clone().filter(|u| !u.is_empty()),
        })
        .collect();
    rows.sort_by(|a, b| a.code.cmp(&b.code));
    Ok(Json(rows))
}

#[derive(Serialize)]
struct RequestRow {
    wallet: String,
    state: ApprovalState,
    /// The applicant's handle, when they have claimed one.
    ///
    /// Resolved here because the view's `labels` map cannot cover these: it is
    /// built from `entrant_seats`, i.e. from `players` — and an applicant the
    /// organizer has yet to decide on is by definition not a player. Without
    /// this the one screen where someone is judged by their identity is the one
    /// screen that shows a bare address.
    #[serde(skip_serializing_if = "Option::is_none")]
    username: Option<String>,
}

/// Ask to be let in. The applicant's own call; no money moves here — that is
/// the point of the two-phase join (see `tourney_join`).
async fn tourney_request(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<StatusCode, StatusCode> {
    state.reject_if_rate_limited_create(&headers)?;
    let wallet = state
        .authed_wallet(&headers)
        .ok_or(StatusCode::UNAUTHORIZED)?
        .to_lowercase();
    {
        let mut ts = state.0.lobby.tournaments.lock();
        let t = ts.get_mut(&id).ok_or(StatusCode::NOT_FOUND)?;
        if t.admission != Admission::Approval {
            return Err(StatusCode::BAD_REQUEST); // nothing to request
        }
        if t.status != "open" {
            return Err(StatusCode::CONFLICT);
        }
        // Bounded by the same cap as invites so an open request list can't be
        // used to grow this map (and every persist of it) without limit.
        if !t.approvals.contains_key(&wallet) && t.approvals.len() >= MAX_JOIN_REQUESTS {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        // Re-requesting never overwrites a decision: an applicant must not be
        // able to clear their own rejection by asking again.
        t.approvals.entry(wallet).or_insert(ApprovalState::Pending);
    }
    let _ = persist_tournament(&state, id).await;
    Ok(StatusCode::ACCEPTED)
}

/// The request list. Organizer-only.
async fn tourney_requests_list(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Vec<RequestRow>>, StatusCode> {
    state.reject_if_rate_limited_polls(&headers)?;
    let caller = state.authed_wallet(&headers);
    // Lock-scoped, so the username lookup below can await without holding it.
    let mut rows: Vec<RequestRow> = {
        let ts = state.0.lobby.tournaments.lock();
        let t = ts.get(&id).ok_or(StatusCode::NOT_FOUND)?;
        if !is_organizer(t, caller.as_deref()) {
            return Err(StatusCode::FORBIDDEN);
        }
        t.approvals
            .iter()
            .map(|(wallet, state)| RequestRow {
                wallet: wallet.clone(),
                state: *state,
                username: None,
            })
            .collect()
    };
    // One batched query, like `entrant_labels`. Organizer-only and rarely
    // polled, so this is nowhere near the lobby list's cost profile.
    if let Some(db) = state.0.db.as_ref() {
        let wallets: Vec<String> = rows.iter().map(|r| r.wallet.clone()).collect();
        if let Ok(names) = db.usernames_for(&wallets).await {
            for row in rows.iter_mut() {
                row.username = names.get(&row.wallet.to_lowercase()).cloned();
            }
        }
    }
    rows.sort_by(|a, b| a.wallet.cmp(&b.wallet));
    Ok(Json(rows))
}

#[derive(Deserialize)]
struct DecideReq {
    approve: bool,
}

/// Approve or reject an applicant. Organizer-only.
async fn tourney_request_decide(
    State(state): State<AppState>,
    Path((id, wallet)): Path<(Uuid, String)>,
    headers: HeaderMap,
    Json(req): Json<DecideReq>,
) -> Result<StatusCode, StatusCode> {
    state.reject_if_rate_limited_create(&headers)?;
    let caller = state.authed_wallet(&headers);
    {
        let mut ts = state.0.lobby.tournaments.lock();
        let t = ts.get_mut(&id).ok_or(StatusCode::NOT_FOUND)?;
        if !is_organizer(t, caller.as_deref()) {
            return Err(StatusCode::FORBIDDEN);
        }
        let key = wallet.to_lowercase();
        // Only a wallet that actually asked can be decided on, so the map stays
        // a record of requests rather than a place to write arbitrary keys.
        let slot = t.approvals.get_mut(&key).ok_or(StatusCode::NOT_FOUND)?;
        *slot = if req.approve {
            ApprovalState::Approved
        } else {
            ApprovalState::Rejected
        };
    }
    let _ = persist_tournament(&state, id).await;
    Ok(StatusCode::NO_CONTENT)
}

/// Whether an entrant id is itself a wallet (a buy-in entrant) rather than a
/// chosen nickname (a casual one).
///
/// Case-SENSITIVE on the `0x`, deliberately. Every id written today comes from
/// `authed_wallet`, which lowercases — so nothing legitimate is `0X…`, while a
/// nickname persisted under the old name-keyed model could be. Matching it
/// case-insensitively would newly resolve such a nickname AS that wallet, which
/// is the impersonation this predicate is the gate for.
fn is_wallet_id(p: &str) -> bool {
    p.starts_with("0x") && p.len() == 42
}

/// The wallet a tournament seat is bound to.
///
/// A bot entrant's games belong to the wallet that registered the agent; a
/// casual browser entrant's to the session they joined with (recorded in
/// `entrant_wallets`); a buy-in entrant's id already IS its wallet. One function
/// because several callers need the identical answer: the seat builder, the
/// label resolver that says what the standings table calls that seat, and the
/// launch-token guard. If they ever disagreed, the crosstable and the board
/// would print different names for the same person — or worse, one of them
/// would trust a binding the others refuse.
///
/// **Every entrant id is a wallet now.** Both branches of `tourney_join_inner`
/// push the SIWE-authenticated wallet, so the `is_wallet_id` fallback below is
/// the normal resolution path rather than a special case — including for a
/// casual tournament, whose ids stopped being client-chosen nicknames. Do NOT
/// reintroduce a "casual ids aren't wallets" condition here: it would unbind
/// every casual seat, and with it the history and casual Elo that binding
/// exists to record. `entrant_wallets` remains only to resolve entrants seated
/// under the old name-keyed model, and is preferred when present.
fn entrant_wallet(
    bots: &HashMap<String, BotEntry>,
    wallets: &HashMap<String, String>,
    p: &str,
) -> Option<String> {
    match bots.get(p) {
        Some(be) => Some(be.wallet.clone()),
        None => wallets
            .get(p)
            .cloned()
            .or_else(|| is_wallet_id(p).then(|| p.to_string())),
    }
}

/// Entrant id -> display label, for every entrant of these tournaments.
///
/// The label is the SERVER'S decision, never the client's, and it matches what
/// `seat_info` prints on the board (main.rs): a wallet's claimed username, else
/// its short address; a guest's chosen nickname, `~`-decorated so it can never
/// be read as a username. That is what keeps the crosstable calling a player
/// exactly what the board calls them — and it is what stops a guest who typed a
/// real user's handle from having it rendered undecorated in the standings.
///
/// Resolved after the lobby lock is dropped and in a single batched query — the
/// tournament list is the heaviest poll on the router and already walks
/// O(entrants²) under that lock. An entrant who joins between the snapshot and
/// this read simply has no label for one poll, which is the right failure: a
/// label is decoration, and the id underneath it is what everything is keyed on.
async fn entrant_labels(state: &AppState, seats: &[EntrantSeats]) -> Vec<HashMap<String, String>> {
    // Only wallet-bound seats need a username lookup; guests are labelled from
    // their id alone. With no DB (dev/tests) the map is empty and wallets fall
    // through to their short address — exactly what the board does.
    let wallets: Vec<String> = seats
        .iter()
        .flat_map(|m| m.iter().filter_map(|(_, w)| w.clone()))
        .collect();
    let names = match state.0.db.as_ref() {
        Some(db) => db.usernames_for(&wallets).await.unwrap_or_default(),
        None => HashMap::new(),
    };
    seats
        .iter()
        .map(|m| {
            m.iter()
                .map(|(id, w)| {
                    let label = match w {
                        Some(w) => names
                            .get(&w.to_lowercase())
                            .cloned()
                            .unwrap_or_else(|| short_addr(w)),
                        None => crate::username::guest_label(id),
                    };
                    (id.clone(), label)
                })
                .collect()
        })
        .collect()
}

/// One row of the standings table, in the order the pool is paid out.
#[derive(Serialize)]
struct Standing {
    player: String,
    score: f64,
    /// Pairings resolved so far (played games + forfeits).
    played: usize,
    /// 1-based, shared between equal scores (1, 1, 3 …) — which is honest only
    /// because `payout_split` shares the money too. While the pool was paid out
    /// strictly by position, a shared rank promised two entrants an equal
    /// finish and then paid one of them 2.6x the other.
    rank: usize,
    /// Another entrant finished on this exact score, so the two of them share
    /// the prize for those places.
    tied: bool,
    /// This entrant's seat is played by a connected agent.
    bot: bool,
}

/// A pairing in the schedule, played or forfeited. `game_id` is `None` for a
/// forfeit — there is no room to spectate.
#[derive(Serialize)]
struct TourneyPairing {
    game_id: Option<GameId>,
    white: String,
    black: String,
    round: usize,
    /// "white" | "black" | "draw"; absent while the game is still in progress.
    result: Option<String>,
    /// Awarded without a game being played (a bot that was offline at dispatch).
    forfeit: bool,
}

fn result_label(winner: Option<Color>) -> String {
    match winner {
        Some(Color::White) => "white".into(),
        Some(Color::Black) => "black".into(),
        None => "draw".into(),
    }
}

#[derive(Serialize)]
struct TourneyView {
    name: String,
    buy_in: Option<String>,
    status: String,
    players: Vec<String>,
    games: Vec<TourneyPairing>,
    /// Live standings, best first. Present from creation (everyone on 0) so a
    /// client can render the table without special-casing an unstarted event.
    standings: Vec<Standing>,
    /// Round currently in progress (games carry their own `round`), so a client
    /// can pick out the active game to play/spectate.
    current_round: usize,
    /// Total rounds in the schedule (0 until started).
    total_rounds: usize,
    /// Time control, so a client can show the terms before joining.
    initial_secs: u64,
    increment_secs: u64,
    /// The wallet that may start a buy-in tournament (`None` for casual, which
    /// anyone may start).
    organizer: Option<String>,
    /// How the pool is divided: basis points per finishing place, best first.
    payout: PayoutSpec,
    /// The prize pool in USDC base units, entries + sponsorship. `None` when
    /// there is no pool (a casual tournament). A **free-entry** event is
    /// `buy_in: "0"` with a non-zero pool here — that pairing is how a client
    /// tells "free, sponsor-funded" from "casual, no prize".
    pool: Option<String>,
    /// Who may join: `open`, `invite` or `approval`.
    admission: Admission,
    /// Where the CALLING wallet stands with an approval-gated tournament:
    /// `pending`, `approved`, `rejected`, or absent if they never asked (or the
    /// tournament isn't approval-gated). Only the authenticated detail route
    /// fills this in — the lobby list is shared by every client and has no
    /// caller. Nothing here is a credential: it says what the server will do,
    /// and the server re-checks on join anyway.
    #[serde(skip_serializing_if = "Option::is_none")]
    my_admission: Option<ApprovalState>,
    /// What each `standings` row would be paid if the event ended now, in USDC
    /// base units and index-aligned with `standings`. Empty when there is no
    /// pool. Produced by the same `payout_split` that settles, so the table a
    /// player is looking at is the one that pays them.
    prizes: Vec<String>,
    /// Seconds since creation. Gives the lobby a stable sort order that doesn't
    /// depend on a hash map's iteration order.
    age_secs: u64,
    /// Entrant id -> username, for entrants who have one. Display only: every id
    /// in `players`, `standings` and `games` stays the internal key, so a client
    /// renders `labels[id] ?? id` and nothing downstream has to change. This is
    /// what keeps the crosstable calling a player what the board calls them, now
    /// that a seat's name is resolved from its wallet.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    labels: HashMap<String, String>,
}

/// Scores in half-points. Every result moves a score by 0.5 or 1.0, so this is
/// exact — and it lets "same score" be an integer comparison rather than `==`
/// on f64, in a place where the answer decides who gets paid what.
fn half_points(score: f64) -> i64 {
    (score * 2.0).round() as i64
}

/// Final order of the field: score descending, and — because the sort is stable
/// over `players` — equal scores separated by the order the entrants joined.
///
/// This is THE ordering, not one of two: `distribute_pool` and the standings
/// table both read it, so what a player is looking at is what the pool pays.
///
/// Join order still decides where inside a tied bracket an entrant sits, but
/// `payout_split` now pays that whole bracket out equally, so it no longer
/// decides anyone's money — only the row order on screen.
fn ranked_entrants(t: &Tournament) -> Vec<(&str, f64)> {
    let mut order: Vec<(&str, f64)> = t
        .players
        .iter()
        .map(|p| (p.as_str(), t.scores.get(p).copied().unwrap_or(0.0)))
        .collect();
    order.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    order
}

fn standings_of(t: &Tournament) -> Vec<Standing> {
    let mut played: HashMap<&str, usize> = HashMap::new();
    for (w, b) in t
        .games
        .iter()
        .filter(|g| g.result.is_some())
        .map(|g| (g.white.as_str(), g.black.as_str()))
        .chain(
            t.forfeits
                .iter()
                .map(|f| (f.white.as_str(), f.black.as_str())),
        )
    {
        *played.entry(w).or_default() += 1;
        *played.entry(b).or_default() += 1;
    }
    let order = ranked_entrants(t);
    order
        .iter()
        .enumerate()
        .map(|(i, (p, score))| {
            let level = order
                .iter()
                .filter(|(_, s)| half_points(*s) == half_points(*score))
                .count();
            Standing {
                player: (*p).to_string(),
                score: *score,
                played: played.get(p).copied().unwrap_or(0),
                // Standard competition ranking: equal scores share the place,
                // and `payout_split` pays the bracket out equally to match.
                rank: order
                    .iter()
                    .position(|(_, s)| half_points(*s) == half_points(*score))
                    .unwrap_or(i)
                    + 1,
                tied: level > 1,
                bot: t.entrant_bots.contains_key(*p),
            }
        })
        .collect()
}

/// Pairings the schedule has produced, played and forfeited alike, ordered by
/// round.
///
/// `scope` exists for one reason: a 128-entrant field is C(128,2) = 8128
/// pairings, and the lobby list serializes EVERY tournament on a 3s poll for
/// every connected client. The lobby only needs the round in progress (that is
/// what tells a client its board should be open), so it asks for
/// `Pairings::CurrentRound` and the detail route serves the rest.
#[derive(Clone, Copy, PartialEq)]
enum Pairings {
    All,
    CurrentRound,
}

fn pairings_of(t: &Tournament, scope: Pairings) -> Vec<TourneyPairing> {
    let keep = |round: usize| scope == Pairings::All || round == t.current_round;
    let mut out: Vec<TourneyPairing> = t
        .games
        .iter()
        .filter(|g| keep(g.round))
        .map(|g| TourneyPairing {
            game_id: Some(g.game_id),
            white: g.white.clone(),
            black: g.black.clone(),
            round: g.round,
            result: g.result.map(result_label),
            forfeit: false,
        })
        .chain(
            t.forfeits
                .iter()
                .filter(|f| keep(f.round))
                .map(|f| TourneyPairing {
                    game_id: None,
                    white: f.white.clone(),
                    black: f.black.clone(),
                    round: f.round,
                    result: Some(result_label(f.winner)),
                    forfeit: true,
                }),
        )
        .collect();
    out.sort_by_key(|p| p.round);
    out
}

/// The pool to show, in USDC base units. `None` for a tournament without one.
///
/// Prefers the cached onchain figure (`pool_refresh_task`), which is the only
/// one that can see sponsorship. Falls back to `buy_in × entrants` until the
/// first read lands, and that fallback can be wrong in EITHER direction: it
/// misses sponsorship, and it counts an entrant whose `enterTournament` failed
/// onchain. Display only, and never the number that pays — `distribute_pool`
/// re-reads the chain and fails closed if it can't.
fn pool_of(t: &Tournament, entrants: usize) -> Option<u128> {
    if !has_pool(t.buy_in.as_deref()) {
        return None;
    }
    t.pool
        .or_else(|| entry_fee(t.buy_in.as_deref()).checked_mul(entrants as u128))
}

/// What the pool would pay each standings row if the event ended now.
///
/// Runs under the lobby lock on a route every client polls, so it reads the
/// cached pool rather than the chain. Settlement re-reads the chain itself
/// (`distribute_pool`) — this table is a promise, that one is the payment.
fn prizes_of(t: &Tournament, standings: &[Standing]) -> Vec<String> {
    let Some(buy_in) = pool_of(t, standings.len()) else {
        return Vec::new(); // casual: no pool, no prizes
    };
    let ranked: Vec<(String, f64)> = standings
        .iter()
        .map(|s| (s.player.clone(), s.score))
        .collect();
    payout_split(buy_in, &ranked, &t.payout)
        .map(|p| p.iter().map(|amt| amt.to_string()).collect())
        .unwrap_or_default()
}

fn view_of(t: &Tournament, scope: Pairings) -> TourneyView {
    let standings = standings_of(t);
    TourneyView {
        name: t.name.clone(),
        buy_in: t.buy_in.clone(),
        status: t.status.clone(),
        players: t.players.clone(),
        games: pairings_of(t, scope),
        prizes: prizes_of(t, &standings),
        pool: pool_of(t, standings.len()).map(|p| p.to_string()),
        standings,
        current_round: t.current_round,
        total_rounds: t.rounds.len(),
        initial_secs: t.initial_secs,
        increment_secs: t.increment_secs,
        organizer: t.organizer.clone(),
        payout: t.payout.clone(),
        admission: t.admission,
        my_admission: None, // filled by `tourney_get`, which has a caller
        age_secs: t.created_at.elapsed().as_secs(),
        // Filled by the handler after the lobby lock is dropped — see
        // `entrant_labels`. Empty here so `view_of` stays sync and lock-scoped.
        labels: HashMap::new(),
    }
}

/// Entrant id → its wallet (if any). One entry per player; a guest carries
/// `None`. Aliased because the nested generic otherwise trips clippy's
/// `type_complexity` where it appears in signatures and the lobby-list tuple.
type EntrantSeats = Vec<(String, Option<String>)>;

/// Entrant id -> its wallet (if any), for EVERY player of `t`. A guest entrant
/// carries `None`. Taken under the lobby lock; resolved to display labels after
/// it is dropped. Every player is included (not just wallet-bound ones) so a
/// guest still gets a `~`-decorated label rather than a raw, forgeable nickname.
fn entrant_seats(t: &Tournament) -> EntrantSeats {
    t.players
        .iter()
        .map(|p| {
            (
                p.clone(),
                entrant_wallet(&t.entrant_bots, &t.entrant_wallets, p),
            )
        })
        .collect()
}

async fn tourney_get(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<TourneyView>, StatusCode> {
    state.reject_if_rate_limited_polls(&headers)?;
    let caller = state.authed_wallet(&headers).map(|w| w.to_lowercase());
    // Everything that needs the lobby lock happens here, so the batched
    // username read below can await without holding it.
    let (mut view, seats) = {
        let t = state.0.lobby.tournaments.lock();
        let t = t.get(&id).ok_or(StatusCode::NOT_FOUND)?;
        let mut view = view_of(t, Pairings::All);
        view.my_admission = caller.and_then(|w| t.approvals.get(&w).copied());
        (view, entrant_seats(t))
    };
    view.labels = entrant_labels(&state, std::slice::from_ref(&seats))
        .await
        .swap_remove(0);
    Ok(Json(view))
}

/// The lobby, with each tournament's view inlined. `tournament_id` is kept as
/// its own field so a client built against the id-only version of this route
/// keeps working — worth the duplication, because the web app deploys on merge
/// while this server only moves when someone runs the deploy script.
///
/// `games` here holds only the round in progress (see `Pairings`); fetch the
/// tournament by id for the full crosstable.
#[derive(Serialize)]
struct TourneySummary {
    tournament_id: Uuid,
    #[serde(flatten)]
    view: TourneyView,
}

async fn tourney_list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<TourneySummary>>, StatusCode> {
    // The heaviest poll on the router: standings_of is O(entrants²) per
    // tournament and the whole walk holds the lobby mutex — hence the throttle
    // and the max_lobby_tournaments cap at creation.
    state.reject_if_rate_limited_polls(&headers)?;
    let (mut out, seats): (Vec<TourneySummary>, Vec<EntrantSeats>) = {
        let t = state.0.lobby.tournaments.lock();
        t.iter()
            .map(|(id, t)| {
                (
                    TourneySummary {
                        tournament_id: *id,
                        view: view_of(t, Pairings::CurrentRound),
                    },
                    entrant_seats(t),
                )
            })
            .unzip()
    };
    // One batched query for the whole lobby, with the lock already released.
    for (s, labels) in out.iter_mut().zip(entrant_labels(&state, &seats).await) {
        s.view.labels = labels;
    }
    // Newest first — the map's iteration order is arbitrary, and a lobby that
    // reshuffles on every 3s poll is unusable.
    out.sort_by_key(|s| s.view.age_secs);
    Ok(Json(out))
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
    state.reject_if_rate_limited_polls(&headers)?;
    let t = state.0.lobby.tournaments.lock();
    let t = t.get(&id).ok_or(StatusCode::NOT_FOUND)?;
    let me = if t.buy_in.is_some() {
        state
            .authed_wallet(&headers)
            .ok_or(StatusCode::UNAUTHORIZED)?
    } else {
        // Casual: the entrant id comes in on the query string. A launch token
        // DRIVES a seat, so who may fetch one matters — and it matters more now
        // that a casual entrant IS a wallet: the id is no longer a nickname an
        // attacker has to learn, it is an address printed in the standings.
        // Anyone could read one off the crosstable and play that person's seat.
        //
        // A bot entrant is exempt because its token is always empty (its agent
        // plays the seat), so its game list is spectator info.
        //
        // Resolved through `entrant_wallet` rather than a private lookup: that
        // helper is the one definition of who owns a seat, and it also covers an
        // entrant seated under the old name-keyed model, whose wallet lives in
        // `entrant_wallets`. `None` means an unbound legacy guest — nothing to
        // protect and nothing attributable, so the id alone still suffices, which
        // keeps such an entrant able to finish the event they are already in.
        let player = q.player.ok_or(StatusCode::BAD_REQUEST)?;
        let is_bot_entrant = t
            .entrant_bots
            .keys()
            .any(|k| k.eq_ignore_ascii_case(&player));
        if !is_bot_entrant {
            let bound = t
                .players
                .iter()
                .find(|p| p.eq_ignore_ascii_case(&player))
                .and_then(|p| entrant_wallet(&t.entrant_bots, &t.entrant_wallets, p));
            if let Some(bound) = bound {
                let caller = state
                    .authed_wallet(&headers)
                    .ok_or(StatusCode::UNAUTHORIZED)?;
                if !caller.eq_ignore_ascii_case(&bound) {
                    return Err(StatusCode::FORBIDDEN);
                }
            }
        }
        player
    };
    // A bot entrant's seats are played by its agent — hand the browser no token
    // (it spectates); a browser entrant gets its real launch token. Matched
    // case-insensitively like every other identity comparison here: the web
    // client lowercases the display name it sends, so an exact-match lookup
    // missed any entrant who typed a capital letter and handed their browser a
    // live token for a seat their agent was already playing.
    let is_bot = t.entrant_bots.keys().any(|k| k.eq_ignore_ascii_case(&me));
    let seat = if is_bot { "bot" } else { "browser" };
    let tok = |real: &str| {
        if is_bot {
            String::new()
        } else {
            real.to_string()
        }
    };
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
///
/// Also the **resume** path for a tournament the server paused mid-round
/// (maintenance drain, room ceiling): it keeps the existing schedule, scores and
/// round position and re-dispatches only the pairings that never got a game.
async fn tourney_start(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<Vec<TourneyGame>>, StatusCode> {
    // Drain: reject before spawning any games.
    state.reject_if_draining()?;
    state.reject_if_rate_limited_create(&headers)?;
    let caller = state.authed_wallet(&headers);

    // A free-entry event's prize is entirely the sponsors'. Nobody has paid
    // anything in, so an unfunded one would run a full round-robin and pay out
    // nothing — and unlike a buy-in tournament there is no entry to refund
    // afterwards, so the entrants' time is simply gone. Read the chain and
    // refuse; the organizer retries once a sponsor has funded it.
    {
        let terms = {
            let ts = state.0.lobby.tournaments.lock();
            let t = ts.get(&id).ok_or(StatusCode::NOT_FOUND)?;
            (t.buy_in.clone(), t.status.clone())
        };
        let (buy_in, status) = terms;
        let free_prize_event =
            has_pool(buy_in.as_deref()) && entry_fee(buy_in.as_deref()) == 0 && status == "open";
        if free_prize_event && state.0.settlement.is_onchain() {
            let funded = state
                .0
                .settlement
                .tournament_pool(id)
                .await
                .is_some_and(|p| p > U256::ZERO);
            if !funded {
                tracing::warn!(tournament = %id, "refusing to start a free-entry event with an empty prize pool");
                return Err(StatusCode::CONFLICT);
            }
        }
    }

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
        validate_tc(t.initial_secs, t.increment_secs)?;
        // Resuming a tournament the server paused mid-round (see
        // `dispatch_from_current`) keeps its schedule, scores and position —
        // rebuilding the schedule would re-pair a field that has already played
        // rounds, and resetting `current_round` would replay them.
        if t.status != "paused" {
            if t.status != "open" || t.players.len() < 2 {
                return Err(StatusCode::CONFLICT);
            }
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
        }
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
            // Persist "complete" BEFORE settling. Otherwise a crash between the
            // settlement enqueue (inside settle_tournament) and its "settled"
            // write leaves the durable row at "running" — which
            // recover_tournaments marks ABANDONED on reboot, surfacing a refund
            // path for a pool the durable outbox is meanwhile paying out.
            // "complete" is neither rehydrated nor abandoned; the outbox finishes
            // it. (Settlement itself stays idempotent via the contract's
            // AlreadySettled + the outbox's is_tournament_settled check.)
            if let Some(db) = &state.0.db {
                let _ = db.set_tournament_status(tid, "complete").await;
            }
            settle_tournament(state, tid).await;
            return;
        };
        let d = dispatch_round(state, tid, round_idx).await;
        if let Some(code) = d.blocked {
            // The server declined to create a game. Park the tournament exactly
            // where it is: `current_round` does not advance, no pairing is
            // scored, and nothing settles. Any games this round DID start keep
            // playing and record their results; `record_outcome` only advances a
            // "running" tournament, so a paused one freezes instead of falling
            // through to settlement on a half-played round.
            //
            // Resume with POST /tournaments/{id}/start once the cause has
            // cleared — dispatch_round is idempotent per pairing, so the round
            // picks up exactly where it stopped.
            if let Some(t) = state.0.lobby.tournaments.lock().get_mut(&tid) {
                t.status = "paused".into();
            }
            if let Some(db) = &state.0.db {
                let _ = db.set_tournament_status(tid, "paused").await;
            }
            tracing::error!(
                tournament = %tid,
                round = round_idx,
                status = %code,
                "round dispatch blocked — tournament paused, NOT scored"
            );
            crate::alert::fire(format!(
                "⚠️ OpenChess: tournament {tid} paused at round {} — the server refused to \
                 create its games ({code}). Nothing was scored and no pool was settled. \
                 Resume it with POST /tournaments/{tid}/start once the cause has cleared \
                 (maintenance drain? room ceiling?).",
                round_idx + 1
            ));
            return;
        }
        if d.live > 0 {
            return; // games in flight; results_task advances when they finish
        }
        // All-forfeit (or empty) round → advance and try the next.
        if let Some(t) = state.0.lobby.tournaments.lock().get_mut(&tid) {
            t.current_round += 1;
        }
    }
}

/// What one `dispatch_round` call left behind.
struct RoundDispatch {
    /// Unresolved games in this round after the call — what `round_remaining`
    /// was set to. Zero means the round is fully resolved and the schedule may
    /// advance.
    live: usize,
    /// Set when the SERVER refused to create a game: the maintenance drain, the
    /// global room ceiling, a failed persist, a failed escrow open. Categorically
    /// different from a pairing that *cannot be played* (a bot seat that is
    /// offline), which is a forfeit and scores like a game. See
    /// `dispatch_from_current` for what this stops.
    blocked: Option<StatusCode>,
}

/// Dispatch every pairing of round `round_idx`: create a game per pairing whose
/// seats can be filled, and immediately FORFEIT any pairing where a bot seat is
/// offline/busy (its opponent wins; both unavailable ⇒ draw). Sets
/// `round_remaining` to the number of unresolved games in the round.
///
/// **Idempotent per pairing.** A pairing that already has a game or a recorded
/// forfeit for this round is skipped, so a round that was only partly dispatched
/// (because the server blocked partway through) can be finished by calling this
/// again — without double-creating the games that did get through.
async fn dispatch_round(state: &AppState, tid: Uuid, round_idx: usize) -> RoundDispatch {
    // Snapshot pairings + tc + bot entrants (never hold the lock across .await).
    // The buy-in comes along as a bool: a paid tournament's games are ranked
    // even though no pairing carries a stake of its own (the pool settles
    // separately), and this is the only place that knows it. The amount is
    // irrelevant here, so don't clone the string every round.
    let (pairings, resolved, tc, bots, engines, wallets, ladder) = {
        let ts = state.0.lobby.tournaments.lock();
        let Some(t) = ts.get(&tid) else {
            return RoundDispatch {
                live: 0,
                blocked: None,
            };
        };
        let pairings = t.rounds.get(round_idx).cloned().unwrap_or_default();
        // An unusable time control can never dispatch a game, so treat it as
        // blocked rather than as an empty round: advancing past it would walk
        // the whole schedule scoring nothing and settle the pool on a field
        // where nobody played. Can't happen from the normal flow (tc is
        // validated at create and again at start) — this is the fail-closed
        // direction for the one that slips through.
        let Ok(tc) = validate_tc(t.initial_secs, t.increment_secs) else {
            return RoundDispatch {
                live: 0,
                blocked: Some(StatusCode::INTERNAL_SERVER_ERROR),
            };
        };
        // Pairings already resolved in this round, by game or by forfeit. This
        // is what makes re-dispatch safe (see the doc comment).
        let resolved: HashSet<(String, String)> = t
            .games
            .iter()
            .filter(|g| g.round == round_idx)
            .map(|g| (g.white.clone(), g.black.clone()))
            .chain(
                t.forfeits
                    .iter()
                    .filter(|f| f.round == round_idx)
                    .map(|f| (f.white.clone(), f.black.clone())),
            )
            .collect();
        let ladder = tournament_ladder(t.buy_in.as_deref());
        (
            pairings,
            resolved,
            tc,
            t.entrant_bots.clone(),
            t.entrant_engines.clone(),
            t.entrant_wallets.clone(),
            ladder,
        )
    };

    let seat_meta = |p: &str| SeatMeta {
        // An entrant id is either a wallet (buy-in) or a chosen nickname
        // (casual) — decided by the TOURNAMENT, never by the shape of the id,
        // for the reason spelled out on `entrant_wallet`. Only the nickname is
        // carried, and only as a fallback: `start_game` ignores this field
        // entirely for any seat that has a wallet, resolving that seat's
        // username instead. So a buy-in entrant, and a casual entrant who signed
        // in, both render as their handle; an anonymous casual entrant renders
        // their nickname, `~`-decorated so it cannot be read as one.
        name: (!is_wallet_id(p)).then(|| p.to_string()),
        // A bot entrant's engine comes from its agent registration; a browser
        // entrant declares its own at join time.
        engine: engines.get(p).cloned(),
        wallet: entrant_wallet(&bots, &wallets, p),
    };
    // Build a seat delivery for an entrant; `Err(())` = its bot is unavailable.
    // A claimed wallet is pushed onto `claimed` for rollback.
    let make_seat = |id: &str, claimed: &mut Vec<String>| -> Result<SeatDelivery, ()> {
        match bots.get(id) {
            None => Ok(SeatDelivery::Browser),
            Some(be) => claim_agent_seat(
                &state.0.agents,
                be.wallet.clone(),
                be.uci_options.clone(),
                claimed,
            )
            .map_err(|_| ()),
        }
    };

    let mut created: Vec<TourneyGame> = Vec::new();
    let mut forfeits: Vec<(String, String, Option<Color>)> = Vec::new();
    let mut blocked: Option<StatusCode> = None;
    for (white, black) in pairings {
        if resolved.contains(&(white.clone(), black.clone())) {
            continue; // already played or forfeited in this round
        }
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
                        None, // the buy-in is a pool, never a per-game wager
                        ladder,
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
                        result: None,
                        white_token: resp.white_token,
                        black_token: resp.black_token,
                    }),
                    // The agent vanished between the claim and the dispatch:
                    // neither side got to play → score it a draw (start_game has
                    // already aborted the game and refunded any escrow).
                    Err(StatusCode::FAILED_DEPENDENCY) => {
                        release(&claimed);
                        forfeits.push((white, black, None));
                    }
                    // Anything else is the SERVER declining, not the pairing
                    // failing: the maintenance drain, the room ceiling, a failed
                    // persist, a failed escrow open. Scoring these as draws
                    // invents a result nobody played — and because an all-forfeit
                    // round makes `dispatch_from_current` advance, one drained
                    // round used to cascade through the entire remaining
                    // schedule and settle a real USDC pool on phantom results,
                    // permanently (`AlreadySettled`). Stop the round instead and
                    // leave every unplayed pairing unscored.
                    Err(e) => {
                        release(&claimed);
                        blocked = Some(e);
                        break;
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
                t.forfeits.push(Forfeit {
                    white: w.clone(),
                    black: b.clone(),
                    round: round_idx,
                    winner: *winner,
                });
            }
            t.games.extend(created.iter().cloned());
        }
    }
    let live = {
        // Every unresolved game of this round, not just the ones created by this
        // call: a re-dispatch (see the doc comment) leaves earlier games of the
        // same round still in flight, and counting only the new ones would let
        // the round "finish" while they were still being played.
        //
        // A game that already finished removed itself from game_to_tournament,
        // so that map is the liveness check. Take the candidate ids under the
        // tournaments lock, release it, then consult the map — never nested, to
        // preserve record_outcome's lock order.
        let candidates: Vec<GameId> = state
            .0
            .lobby
            .tournaments
            .lock()
            .get(&tid)
            .map(|t| {
                t.games
                    .iter()
                    .filter(|g| g.round == round_idx && g.result.is_none())
                    .map(|g| g.game_id)
                    .collect()
            })
            .unwrap_or_default();
        let live = {
            let map = state.0.lobby.game_to_tournament.lock();
            candidates.iter().filter(|id| map.contains_key(id)).count()
        };
        if let Some(t) = state.0.lobby.tournaments.lock().get_mut(&tid) {
            t.round_remaining = live;
        }
        live
    };
    if let Some(db) = &state.0.db {
        for g in &created {
            let _ = db
                .add_tournament_game(tid, g.game_id, &g.white, &g.black)
                .await;
        }
    }
    RoundDispatch { live, blocked }
}

/// Settle a finished tournament: rank all entrants, compute a top-heavy payout
/// split of the pool, and (for a buy-in tournament) distribute onchain.
async fn settle_tournament(state: &AppState, tid: Uuid) {
    // Snapshot terms + final standings (all entrants, including 0-score).
    let (buy_in, payout, standings) = {
        let tourneys = state.0.lobby.tournaments.lock();
        let Some(t) = tourneys.get(&tid) else {
            return;
        };
        // Same ordering the standings table shows — one function, so what a
        // player is looking at is what the pool pays.
        let s: Vec<(String, f64)> = ranked_entrants(t)
            .into_iter()
            .map(|(p, score)| (p.to_string(), score))
            .collect();
        (t.buy_in.clone(), t.payout.clone(), s)
    };
    tracing::info!(tournament = %tid, ?standings, "tournament complete — final standings");

    if let Some(buy_in_str) = buy_in {
        if let Err(e) = distribute_pool(state, tid, &buy_in_str, &standings, &payout).await {
            tracing::error!(tournament = %tid, "tournament settlement failed: {e:#}");
            // Leave status 'complete' so it can be inspected — but nothing
            // automatically retries this (the schedule is exhausted, so no
            // round-advance ever runs again). Without the alert, the pool sits
            // unsettled until the contract's settle window closes and entrants
            // are pushed to claimRefund.
            crate::alert::fire(format!(
                "🚨 OpenChess: tournament {tid} finished but its pool was NOT settled \
                 ({e:#}). It is parked at status 'complete' with no automatic retry; \
                 entrants' buy-ins stay locked until this is settled manually or the \
                 settle window lapses into claimRefund."
            ));
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

/// Can an `open` row be put back in the lobby?
///
/// A buy-in tournament may only be started by its organizer, so a row without
/// one can never start. Rows written before that column existed are exactly
/// that. Rehydrating one would invite fresh entrants to lock USDC into a pool
/// that can never pay out — worse than leaving it invisible, which is what
/// those rows already were; entrants recover via the contract's `claimRefund`.
fn is_rehydratable(buy_in: Option<&str>, organizer: Option<&str>) -> bool {
    buy_in.is_none() || organizer.is_some()
}

/// The entrant field of a rehydrated tournament, after re-gating.
pub struct Rehydrated {
    players: Vec<String>,
    entrant_bots: HashMap<String, BotEntry>,
    entrant_wallets: HashMap<String, String>,
}

/// Re-apply the entrant rules to a field restored from Postgres.
///
/// `recover_tournaments` is a writer into the lobby that never passes through
/// `tourney_join_inner`, so a rule enforced only at the join door is not
/// enforced for a row written before that rule existed.
///
/// **A pooled tournament carries no `entrant_wallets`.** Its ids ARE the SIWE
/// wallets — neither join branch writes that map for one — and `entrant_wallet`
/// prefers a `wallets` entry over the id, so a single stored row keyed on a paid
/// entrant would rebind that seat, its onchain-settled identity and its ranked
/// Elo to an arbitrary address. No writer can produce one; this asserts it
/// rather than trusting it.
///
/// Deliberately NOT filtered: address-shaped ids. Since entrants became
/// wallet-keyed in every tournament, a casual field is legitimately full of
/// addresses, and a filter that dropped them would delete the entire field on
/// the next restart — permanently, because `players` is in
/// `upsert_tournament`'s DO UPDATE set. The residual it would have addressed is
/// a nickname persisted under the old name-keyed model that happens to look
/// like an address: `is_wallet_id` stays case-sensitive so `0X…` can't resolve,
/// a lowercase one is indistinguishable from a legitimate wallet entrant here,
/// and no new one can be created — the join no longer accepts a nickname at all.
/// TOURNEY_TTL evicts whatever is left within a day.
fn rehydrated_entrants(
    buy_in: Option<&str>,
    players: Vec<String>,
    bots: HashMap<String, BotEntry>,
    wallets: HashMap<String, String>,
) -> Rehydrated {
    Rehydrated {
        players,
        entrant_bots: bots,
        entrant_wallets: if has_pool(buy_in) {
            HashMap::new()
        } else {
            wallets
        },
    }
}

/// The admission a stored row comes back with.
///
/// Normally exactly what was stored — a tournament that came back `Open` would
/// be a closed door that silently stopped existing. The exception is the
/// create-time rule this restores under: a pooled event with a ~free entry may
/// not be `Open` (see `MIN_OPEN_ENTRY_FEE`), and rows written before that rule
/// existed are still in Postgres. Rehydrating one verbatim would put a drainable
/// event back in the lobby — the gate undone by the one writer that never went
/// through it. Tightening is always safe: the organizer can still admit anyone.
fn rehydrated_admission(stored: Admission, buy_in: Option<&str>) -> Admission {
    if stored == Admission::Open && has_pool(buy_in) && entry_fee(buy_in) < MIN_OPEN_ENTRY_FEE {
        Admission::Approval
    } else {
        stored
    }
}

/// Which ladder a tournament's pairings count for.
///
/// The entry fee is the only money in a tournament — no pairing carries a
/// wager of its own — so this is the one place rankedness can't be inferred
/// from the game. `buy_in` is persisted (migration 0005) and restored by
/// `recover_tournaments`, so a tournament that survives a restart keeps
/// dispatching ranked games rather than quietly coming back casual.
fn tournament_ladder(buy_in: Option<&str>) -> Ladder {
    // Ranked when the ENTRANT had money at risk, which is the rule everywhere
    // else — not merely when a pool exists. A sponsor-funded free-entry event
    // pays real USDC but costs nothing to enter, so two cooperating wallets
    // could trade wins in one and farm ranked Elo for free. That is exactly why
    // casual Elo is kept off the leaderboard, and it is why a nominal entry fee
    // is the lever a creator uses to make their event ranked.
    if entry_fee(buy_in) > 0 {
        Ladder::Ranked
    } else {
        Ladder::Casual
    }
}

/// What each entrant pays, in USDC base units. Zero for a casual tournament
/// (no pool at all) and for a free-entry one (`Some("0")` — a pool exists, but
/// it is sponsor-funded). Unparseable is treated as zero: the value has already
/// been validated at create, and this is read on paths where refusing to answer
/// would be worse than treating an impossible row as free.
///
/// **Parsed as `U256` — the same way the money paths parse it — and only then
/// narrowed.** A plain `u128::from_str` disagrees with `U256::from_str` on
/// strings like `"0x1E8480"`, which the charging path (`tourney_join_inner`)
/// reads as 2 USDC while this read 0. That divergence is not cosmetic now that
/// this function decides two things it didn't used to: which ladder the pairings
/// count for, and whether the event may be `Open`. Agreeing with whoever takes
/// the money is the invariant. A value too large for `u128` still reads as 0,
/// which fails CLOSED on both (casual ladder, gated admission).
fn entry_fee(buy_in: Option<&str>) -> u128 {
    buy_in
        .and_then(|b| b.parse::<U256>().ok())
        .and_then(|u| u128::try_from(u).ok())
        .unwrap_or(0)
}

/// Does this tournament have an onchain prize pool at all?
///
/// `buy_in.is_some()` — kept as the flag it has always been, so every existing
/// check (wallet-identity entrants, organizer-gated start, authenticated
/// `my-games`, settlement) stays correct without modification. A free-entry
/// sponsored tournament is `Some("0")`: pool yes, fee zero.
fn has_pool(buy_in: Option<&str>) -> bool {
    buy_in.is_some()
}

/// How often the cached onchain pool is refreshed.
///
/// Sponsorship is a transaction the sponsor's own browser sends — the server is
/// not in the loop and gets no event — so a pool can grow with nothing
/// server-side to hang a refresh on. It has to be polled. Bounded work: at most
/// `max_lobby_tournaments` view calls per tick, and only for tournaments that
/// have a pool and haven't finished with it.
const POOL_REFRESH: Duration = Duration::from_secs(15);
/// Pools read per tick. `max_lobby_tournaments` defaults to 256, and these are
/// sequential awaited view calls — an unbounded sweep of a full lobby takes far
/// longer than the interval above, so the task stops sleeping in any meaningful
/// sense and becomes a permanent load on the same RPC the oracle needs to
/// settle with. Bounded and rotated instead: every tournament still gets a
/// refresh, just within a few ticks rather than every one.
const POOL_REFRESH_BATCH: usize = 32;

/// Keep each live tournament's cached pool roughly current, for display.
pub async fn pool_refresh_task(state: AppState) {
    // Where the last tick stopped, so a lobby larger than one batch is covered
    // in turn instead of the same head being refreshed forever.
    let mut cursor = 0usize;
    loop {
        tokio::time::sleep(POOL_REFRESH).await;
        cursor = refresh_pools(&state, cursor).await;
    }
}

/// The slice of `ids` this tick should read, and where the next should resume.
///
/// Split out from the awaiting loop because this is the part that can be wrong
/// in a way no build catches: an off-by-one either re-reads one head forever
/// (starving the tail) or skips ids entirely. Wraps, so a batch spanning the
/// end continues from the front.
fn refresh_batch(ids: &[Uuid], cursor: usize) -> (Vec<Uuid>, usize) {
    if ids.is_empty() {
        return (Vec::new(), 0);
    }
    let start = cursor % ids.len();
    let take = POOL_REFRESH_BATCH.min(ids.len());
    let batch: Vec<Uuid> = ids.iter().cycle().skip(start).take(take).copied().collect();
    (batch, (start + take) % ids.len())
}

/// Refresh up to `POOL_REFRESH_BATCH` pools starting at `cursor`; returns where
/// the next tick should resume.
async fn refresh_pools(state: &AppState, cursor: usize) -> usize {
    if !state.0.settlement.is_onchain() {
        return 0;
    }
    // Snapshot the ids, then read — never hold the lobby lock across an await.
    //
    // Only a tournament that can still be funded is worth asking about: a
    // `complete` one is waiting on settlement, which re-reads the chain itself,
    // and sponsorship is refused past the settle window anyway. Sorted so the
    // rotation below is stable — the map's own iteration order is arbitrary and
    // reshuffles, which would starve some ids and re-read others.
    let ids: Vec<Uuid> = {
        let ts = state.0.lobby.tournaments.lock();
        let mut ids: Vec<Uuid> = ts
            .iter()
            .filter(|(_, t)| {
                has_pool(t.buy_in.as_deref())
                    && matches!(t.status.as_str(), "open" | "running" | "paused")
            })
            .map(|(id, _)| *id)
            .collect();
        ids.sort_unstable();
        ids
    };
    let (batch, next) = refresh_batch(&ids, cursor);
    for id in batch {
        let Some(pool) = state.0.settlement.tournament_pool(id).await else {
            continue; // transient RPC failure: keep the previous figure
        };
        let Ok(pool) = u128::try_from(pool) else {
            continue;
        };
        if let Some(t) = state.0.lobby.tournaments.lock().get_mut(&id) {
            t.pool = Some(pool);
        }
    }
    next
}

/// Recover tournaments after a restart.
///
/// An **open** tournament is rebuilt in memory verbatim: it has no in-flight
/// rooms, so its durable row (name, terms, organizer, entrants, bot bindings) is
/// the whole of it. Skipping this used to make a restart *delete* the lobby —
/// `GET /tournaments` went empty and the detail route 404'd while the onchain
/// pool stayed open and every entrant's buy-in stayed locked, with no way left
/// to start the thing they'd paid into.
///
/// A **running** tournament is a different story: its rooms are gone. Round-based
/// dispatch persists only the rounds played SO FAR, so "all persisted games
/// finished" does NOT mean the tournament is complete — settling here would risk
/// paying the pool out on partial standings (and the contract's `AlreadySettled`
/// makes that permanent). Forfeit results aren't persisted either, so re-derived
/// standings would be wrong regardless. So it's abandoned: entrants recover their
/// buy-in via the contract's `claimRefund`. A tournament that actually finished
/// AND enqueued settlement is completed by the durable settlement outbox (drained
/// separately on boot), which carries the correct standings — not by this path.
pub async fn recover_tournaments(state: &AppState) {
    let Some(db) = &state.0.db else { return };

    // Rehydrate the open lobby. Capped: TOURNEY_TTL evicts these after 24h
    // anyway, and boot shouldn't drag in an unbounded backlog.
    match db.open_tournaments(OPEN_TOURNAMENT_RESTORE_LIMIT).await {
        Ok(rows) => {
            let found = rows.len();
            let mut restored = 0usize;
            let mut ts = state.0.lobby.tournaments.lock();
            for r in rows {
                if !is_rehydratable(r.buy_in.as_deref(), r.organizer.as_deref()) {
                    tracing::warn!(
                        tournament = %r.id,
                        "skipping rehydration: buy-in tournament has no organizer, so nobody could start it"
                    );
                    continue;
                }
                // Preserve the original age so TTL eviction still fires on
                // schedule rather than restarting the clock on every deploy.
                // `Instant` is monotonic-since-boot, so on a freshly restarted
                // host subtracting hours can underflow: fall back to "now"
                // rather than drop the row. Losing TTL precision is cosmetic;
                // dropping the tournament is the exact data loss this whole
                // function exists to prevent.
                let age = Duration::from_secs(r.age_secs.max(0) as u64).min(TOURNEY_TTL);
                let created_at = Instant::now().checked_sub(age).unwrap_or_else(Instant::now);
                let stored_players: Vec<String> =
                    serde_json::from_value(r.players).unwrap_or_default();
                let before = stored_players.len();
                let Rehydrated {
                    players,
                    entrant_bots,
                    entrant_wallets,
                } = rehydrated_entrants(
                    r.buy_in.as_deref(),
                    stored_players,
                    bots_from_json(&r.bots),
                    serde_json::from_value(r.entrant_wallets).unwrap_or_default(),
                );
                if players.len() != before {
                    tracing::warn!(
                        tournament = %r.id,
                        dropped = before - players.len(),
                        "dropped unbound address-shaped entrant id(s) from a casual tournament: \
                         a nickname may not impersonate a wallet"
                    );
                }
                // The prize structure has to come back exactly, or the field is
                // paid a table it never agreed to — silently, since the money
                // still moves and the standings still look right. A row whose
                // payout won't parse is skipped rather than defaulted when
                // there is money on it; a casual one can safely take the default.
                let payout: Option<PayoutSpec> = serde_json::from_value(r.payout.clone())
                    .ok()
                    .filter(|p: &PayoutSpec| p.validate().is_ok());
                let payout = match (payout, r.buy_in.is_some()) {
                    (Some(p), _) => p,
                    (None, false) => PayoutSpec::default(),
                    (None, true) => {
                        tracing::error!(
                            tournament = %r.id,
                            payout = %r.payout,
                            "skipping rehydration: buy-in tournament has an unreadable payout \
                             structure, and paying the default would not be what its entrants \
                             agreed to (they refund via claimRefund)"
                        );
                        continue;
                    }
                };
                // Restored, not defaulted — but re-gated on the way back in; see
                // `rehydrated_admission`.
                let stored: Admission =
                    serde_json::from_value(json!(r.admission)).unwrap_or_default();
                let admission = rehydrated_admission(stored, r.buy_in.as_deref());
                if admission != stored {
                    tracing::warn!(
                        tournament = %r.id,
                        "rehydrating a cheap pooled event as approval-gated: it was stored Open, \
                         which today's rules refuse because costless entrants could split a \
                         sponsored pool"
                    );
                }
                ts.entry(r.id).or_insert_with(|| Tournament {
                    name: r.name,
                    buy_in: r.buy_in,
                    payout,
                    admission,
                    // An invite reserved by a join that was still running when
                    // the process died is stored as the empty-string sentinel.
                    // Nothing is in flight after a restart, so hand those back
                    // rather than leaving a code spent by nobody — the one way
                    // a code could be lost for good.
                    invites: serde_json::from_value::<HashMap<String, Option<String>>>(r.invites)
                        .unwrap_or_default()
                        .into_iter()
                        .map(|(code, used)| (code, used.filter(|u| !u.is_empty())))
                        .collect(),
                    approvals: serde_json::from_value(r.approvals).unwrap_or_default(),
                    // Re-read from the chain by `pool_refresh_task`; a
                    // rehydrated tournament shows no pool figure until it is.
                    pool: None,
                    organizer: r.organizer,
                    initial_secs: r.initial_secs.max(0) as u64,
                    increment_secs: r.increment_secs.max(0) as u64,
                    status: "open".into(),
                    players,
                    games: Vec::new(),
                    scores: HashMap::new(),
                    rounds: Vec::new(),
                    current_round: 0,
                    round_remaining: 0,
                    forfeits: Vec::new(),
                    entrant_bots,
                    entrant_engines: serde_json::from_value(r.entrant_engines).unwrap_or_default(),
                    // Restored (attribution is NOT cosmetic — a casual entrant's
                    // games dispatched after a restart still belong to them), but
                    // re-gated first; see `rehydrated_entrants`.
                    entrant_wallets,
                    payout_leaves: Vec::new(),
                    created_at,
                });
                restored += 1;
            }
            if restored > 0 || found > 0 {
                tracing::info!(
                    "rehydrated {restored}/{found} open tournament(s) from the database"
                );
            }
            // Never let a cap hide work silently: if the query came back full,
            // older open tournaments exist that this node will not serve.
            if found as i64 == OPEN_TOURNAMENT_RESTORE_LIMIT {
                tracing::warn!(
                    "open-tournament rehydration hit its {OPEN_TOURNAMENT_RESTORE_LIMIT}-row cap — \
                     older open tournaments were NOT restored"
                );
            }
        }
        Err(e) => tracing::warn!("open-tournament rehydration query failed: {e:#}"),
    }

    let rows = match db.recoverable_tournaments().await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("tournament recovery query failed: {e:#}");
            return;
        }
    };
    for t in rows {
        tracing::warn!(
            tournament = %t.id,
            "tournament interrupted by restart — marking abandoned; entrants refund via claimRefund"
        );
        let _ = db.set_tournament_status(t.id, "abandoned").await;
    }
}

/// The default structure when a creator doesn't specify one: top-heavy 65/25/10.
const DEFAULT_PAYOUT_BPS: [u16; 3] = [6_500, 2_500, 1_000];

/// How a tournament divides its pool: basis points per finishing place, best
/// first. Chosen by the creator, fixed at creation, and persisted — a structure
/// that didn't survive a restart would pay a field something other than what it
/// was promised, silently, since the money still moves.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PayoutSpec {
    pub bps: Vec<u16>,
}

impl Default for PayoutSpec {
    fn default() -> Self {
        Self {
            bps: DEFAULT_PAYOUT_BPS.to_vec(),
        }
    }
}

impl PayoutSpec {
    /// Reject a structure that can't be paid out, at CREATE time — a field that
    /// only discovers its prize table is unpayable at settlement has already
    /// locked its buy-ins.
    fn validate(&self) -> Result<(), &'static str> {
        if self.bps.is_empty() {
            return Err("payout structure names no places");
        }
        if self.bps.len() > MAX_TOURNAMENT_PLAYERS {
            return Err("payout structure names more places than a field can hold");
        }
        if !self.bps.windows(2).all(|w| w[0] >= w[1]) {
            return Err("payout structure must not pay a lower place more than a higher one");
        }
        // Exactly, not at most. Tournaments distribute their whole pool today
        // (the contract rakes `pool - sum(payouts)`), so accepting a short sum
        // would silently convert a creator's arithmetic slip into house revenue.
        // A platform rake, if we ever want one, should be an explicit parameter.
        if self.bps.iter().map(|b| *b as u32).sum::<u32>() != 10_000 {
            return Err("payout structure must sum to exactly 10000 bps");
        }
        Ok(())
    }

    /// The structure's weights resolved for a field of `n`, best first.
    ///
    /// A field SMALLER than the structure (a 50/30/20 event two people turn up
    /// for) orphans the tail. Callers divide by the returned weights' own total
    /// rather than by 10_000, which redistributes that orphaned weight across
    /// the places that do exist, in proportion — dropping it instead would leave
    /// the pool short and hand the difference to the contract's rake, i.e. pay
    /// the house for a thin field. A field LARGER than the structure gets
    /// zeros, which is what a top-heavy structure is for.
    fn weights_for(&self, n: usize) -> Vec<u128> {
        let mut w: Vec<u128> = self.bps.iter().take(n).map(|b| *b as u128).collect();
        w.resize(n, 0);
        w
    }
}

/// How a finished field's pool is divided, in standings order.
///
/// Positions are worth what the tournament's `PayoutSpec` says (65/25/10 unless
/// the creator chose otherwise), and any rounding remainder goes to the top so
/// the whole pool is distributed — the contract rakes `pool - sum(payouts)` to
/// the fee recipient, so this MUST sum to exactly `pool`.
///
/// Tied brackets then share what their positions are collectively worth.
/// Position alone used to decide the money, and position among equal scores is
/// decided by `ranked_entrants`' stable sort over join order — so two entrants
/// who finished dead level were paid 65% and 25% based on who pressed Join
/// first. That is not a tiebreak, it is a prize for being early, worth more
/// than winning a game; and join order is something an entrant controls, so it
/// was a free and repeatable edge.
fn payout_split(
    pool: u128,
    standings: &[(String, f64)],
    spec: &PayoutSpec,
) -> anyhow::Result<Vec<u128>> {
    // Tied brackets are found by scanning for CONTIGUOUS equal scores, which is
    // only correct on ranked input: given [2.0, 1.0, 2.0] the two leaders would
    // be treated as separate brackets and paid 65% and 10%. The sole caller
    // passes `ranked_entrants` output, so this guards against a future one.
    //
    // An error rather than a `debug_assert`, because money paths fail closed
    // and `debug_assert` is compiled out of the release build that actually
    // handles money — it would have been loud in CI and silent in the only
    // place being wrong costs anyone anything. `settle_tournament` logs this
    // and returns before marking the tournament settled or enqueueing a
    // payout, so a bad call pays nobody and stays retriable.
    if !standings
        .windows(2)
        .all(|w| half_points(w[0].1) >= half_points(w[1].1))
    {
        return Err(anyhow::anyhow!(
            "payout_split needs standings in ranked order (score descending)"
        ));
    }
    let n = standings.len();
    let weights = spec.weights_for(n);
    // Divide by the resolved weights' OWN total, not by 10_000: that is what
    // renormalizes a structure naming more places than the field has, so the
    // whole pool still reaches players (see `weights_for`). With a full-size
    // field the total is 10_000 and this is the plain percentage split.
    let total_w: u128 = weights.iter().sum();
    if total_w == 0 {
        // Unreachable via `validate` (weights are non-increasing and sum to
        // 10_000, so the first place is always worth something) — but this
        // divides, and a money path does not get to assume.
        return Err(anyhow::anyhow!("payout structure pays nobody"));
    }
    let mut by_rank = vec![0u128; n];
    let mut assigned = 0u128;
    for i in 0..n {
        by_rank[i] = pool
            .checked_mul(weights[i])
            .ok_or_else(|| anyhow::anyhow!("payout overflow"))?
            / total_w;
        assigned += by_rank[i];
    }
    if n > 0 {
        by_rank[0] += pool - assigned; // full pool distributed (0 rake)
    }

    let mut i = 0;
    while i < n {
        let mut j = i + 1;
        while j < n && half_points(standings[j].1) == half_points(standings[i].1) {
            j += 1;
        }
        if j - i > 1 {
            let total: u128 = by_rank[i..j].iter().sum();
            let members = (j - i) as u128;
            let share = total / members;
            // Base units left over from an indivisible split (at most
            // members-1, i.e. under a millionth of a USDC each). Handed out one
            // apiece from the top so the sum still lands exactly on `total` —
            // the only place entry order still shows up, and now it is worth
            // 0.000001 USDC rather than a quarter of the pool.
            let mut rem = total - share * members;
            for slot in by_rank[i..j].iter_mut() {
                *slot = share
                    + if rem > 0 {
                        rem -= 1;
                        1
                    } else {
                        0
                    };
            }
        }
        i = j;
    }
    Ok(by_rank)
}

async fn distribute_pool(
    state: &AppState,
    tid: Uuid,
    buy_in_str: &str,
    standings: &[(String, f64)],
    spec: &PayoutSpec,
) -> anyhow::Result<()> {
    let n = standings.len();
    // try_from, not `to::<u128>()`: this string can come back from Postgres via
    // recover_tournaments with no revalidation, and `to()` PANICS on overflow —
    // inside the supervised results worker, taking round dispatch down with it.
    let buy_in = u128::try_from(
        buy_in_str
            .parse::<U256>()
            .map_err(|_| anyhow::anyhow!("bad buy-in"))?,
    )
    .map_err(|_| anyhow::anyhow!("buy-in overflows u128"))?;

    // Read the pool from the chain rather than deriving it from the entrant
    // count — see `tournament_pool`. A failed read is retriable, so fail rather
    // than fall back to a derived figure that could exceed the real pool and
    // revert the settlement (or undershoot it and rake the difference). Only a
    // non-onchain sink (tests, the log sink) derives.
    let pool = if state.0.settlement.is_onchain() {
        // Retry a transient RPC failure before giving up: an aborted settlement
        // here has no automatic retry (see POOL_READ_RETRIES). A persistent
        // failure still returns Err, which alerts and parks the pool as before.
        let mut onchain = None;
        for attempt in 0..POOL_READ_RETRIES {
            if let Some(p) = state.0.settlement.tournament_pool(tid).await {
                onchain = Some(p);
                break;
            }
            if attempt + 1 < POOL_READ_RETRIES {
                tokio::time::sleep(std::time::Duration::from_millis(POOL_READ_RETRY_MS)).await;
            }
        }
        let onchain =
            onchain.ok_or_else(|| anyhow::anyhow!("could not read the onchain tournament pool"))?;
        u128::try_from(onchain).map_err(|_| anyhow::anyhow!("pool overflows u128"))?
    } else {
        buy_in
            .checked_mul(n as u128)
            .ok_or_else(|| anyhow::anyhow!("pool overflow"))?
    };

    let by_rank = payout_split(pool, standings, spec)?;

    // `standings` and `by_rank` are the same order, so read across by index —
    // a name-keyed map would silently pay one of them nothing if two entrants
    // ever shared a label.
    let mut addrs = Vec::with_capacity(n);
    let mut payouts = Vec::with_capacity(n);
    for (i, (player, _)) in standings.iter().enumerate() {
        let addr = player
            .parse::<Address>()
            .map_err(|_| anyhow::anyhow!("entrant {player} is not an address"))?;
        addrs.push(addr);
        payouts.push(U256::from(by_rank[i]));
    }

    // Large fields settle via a Merkle root (O(1) per winner claim); small
    // fields settle directly. Settlement is enqueued to a DURABLE outbox (a
    // worker drains it onchain, with retry); with no DB we settle inline.
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
    headers: HeaderMap,
) -> Result<Json<ClaimProof>, StatusCode> {
    // The one tournament GET that can hit Postgres (the outbox fallback below)
    // — throttled for the same reason players.rs parks its DB reads behind a
    // rate-limit layer.
    state.reject_if_rate_limited_polls(&headers)?;
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
    /// A sink that claims to settle onchain and reports a fixed bankroll, so
    /// the buy-in gate can be tested without a chain. `None` models the view
    /// call failing (an RPC blip), which must fail OPEN.
    struct BankrollStub(Option<u64>);

    #[async_trait::async_trait]
    impl ledger::SettlementSink for BankrollStub {
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
        async fn bankroll_of(&self, _who: Address) -> Option<U256> {
            self.0.map(U256::from)
        }
    }

    fn test_state() -> (
        AppState,
        mpsc::Receiver<GameId>,
        mpsc::Receiver<crate::GameOutcome>,
    ) {
        test_state_with_sink(ledger::from_env())
    }

    fn test_state_with_sink(
        settlement: Arc<dyn ledger::SettlementSink>,
    ) -> (
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
            settlement,
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

    /// `tourney_join`'s status code — it now returns the canonical entrant id
    /// on success, and these tests only care whether the join was accepted.
    fn join_code(r: &Result<Json<JoinResp>, StatusCode>) -> StatusCode {
        match r {
            Ok(_) => StatusCode::OK,
            Err(e) => *e,
        }
    }

    fn bearer(token: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("authorization", format!("Bearer {token}").parse().unwrap());
        h
    }

    /// A distinct, well-formed wallet per index — `is_wallet_id` wants `0x` and
    /// 42 characters, which is the shape an entrant id now has in EVERY
    /// tournament, casual or buy-in.
    fn test_wallet(i: usize) -> String {
        format!("0x{:040x}", i + 0xa1)
    }

    /// Seat `n` signed-in browser entrants in a casual tournament and return
    /// their wallets in join order.
    ///
    /// These tests used to pass three nicknames and no session, because a casual
    /// entrant id was a string the client chose. It is the authenticated wallet
    /// now (see `tourney_join_inner`), so every entrant needs a session — which
    /// is the point: there is no longer any way to enter a tournament anonymously.
    async fn seat_entrants(state: &AppState, tid: Uuid, n: usize) -> Vec<String> {
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            let w = test_wallet(i);
            let tok = state.0.auth.mint_session(&w);
            let r = tourney_join(
                State(state.clone()),
                Path(tid),
                bearer(&tok),
                Json(JoinReq {
                    seat: None,
                    uci_options: None,
                    engine: None,
                    invite: None,
                }),
            )
            .await;
            assert_eq!(join_code(&r), StatusCode::OK, "entrant {i} should join");
            out.push(w);
        }
        out
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
        let _ = queue_join(State(state.clone()), bearer(&ta), Json(bot_req()))
            .await
            .expect("A join");
        assert!(
            rx_a.try_recv().is_err(),
            "A must not be dispatched while waiting"
        );
        assert!(
            state.0.agents.claim(wa).is_ok(),
            "A not claimed while waiting"
        );
        state.0.agents.release(wa);

        // Bot B queues — pairs with A; BOTH seats dispatch to their agents.
        let r2 = queue_join(State(state.clone()), bearer(&tb), Json(bot_req()))
            .await
            .expect("B join");

        // Which colour each drew is a coin (`coin_flip`), so assert only that
        // both got A seat.
        assert!(
            matches!(rx_a.try_recv(), Ok(ServerToAgent::AssignSeat { .. })),
            "A got its seat"
        );
        assert!(
            matches!(rx_b.try_recv(), Ok(ServerToAgent::AssignSeat { .. })),
            "B got its seat"
        );

        // B's ticket is matched, holds NO launch token (its bot has it), seat=bot.
        let tr = queue_get(State(state.clone()), Path(r2.0.ticket_id), HeaderMap::new())
            .await
            .expect("ticket")
            .0;
        assert_eq!(tr.status, "matched");
        assert!(tr.token.is_none(), "a bot seat's token stays server-side");
        assert_eq!(tr.seat.as_deref(), Some("bot"));

        // Both agents are now busy (claimed + bound to the game).
        assert!(state.0.agents.claim(wa).is_err(), "A busy");
        assert!(state.0.agents.claim(wb).is_err(), "B busy");
    }

    #[test]
    fn the_coin_orders_the_wager_too() {
        // The colour↔token invariant is covered end-to-end below, but only for
        // CASUAL games: a staked `start_game` needs a DB, so the handler tests
        // can't reach `build_wager`. That call is the one place a wrong flip
        // costs money rather than a flipped board — it opens escrow, and the
        // oracle signs the EIP-712 result against exactly these two addresses.
        // So pin the ordering at the seam both handlers share.
        let poster = "0xaa00000000000000000000000000000000000001";
        let acceptor = "0xbb00000000000000000000000000000000000002";

        let [white, black] = seats(true, poster, acceptor);
        let w = build_wager(white, black, "1000000").expect("wager");
        assert_eq!(w.white, poster.parse::<Address>().unwrap());
        assert_eq!(w.black, acceptor.parse::<Address>().unwrap());

        // The losing side of the coin: escrow must follow, not stay put.
        let [white, black] = seats(false, poster, acceptor);
        let w = build_wager(white, black, "1000000").expect("wager");
        assert_eq!(
            w.white,
            acceptor.parse::<Address>().unwrap(),
            "escrow must be keyed on the seat actually played"
        );
        assert_eq!(w.black, poster.parse::<Address>().unwrap());
    }

    #[test]
    fn seats_is_its_own_inverse() {
        // Packing into [white, black] and unpacking back to (a, b) both go
        // through `seats`, so this is what makes a drift between them
        // impossible rather than merely unlikely.
        for coin in [true, false] {
            let packed = seats(coin, "a", "b");
            let [a, b] = seats(coin, packed[0], packed[1]);
            assert_eq!((a, b), ("a", "b"), "round trip at coin={coin}");
        }
    }

    /// A header map carrying a distinct client IP, so each iteration of the
    /// colour tests below draws on its own rate-limit bucket (the per-IP
    /// `offers`/`create` budgets are far smaller than the sample these need).
    fn from_ip(n: usize) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("fly-client-ip", format!("10.0.0.{n}").parse().unwrap());
        h
    }

    /// A distinct signed-in player: their own IP (the rate limiters key on it)
    /// and their own session (every matchmaking door requires one now, free
    /// games included — see `park_create`). Two of these never collide on the
    /// same-wallet guard, which is why the pairing tests take an index.
    fn player(state: &AppState, n: usize) -> HeaderMap {
        let mut h = from_ip(n);
        let token = state.0.auth.mint_session(&test_wallet(n));
        h.insert("authorization", format!("Bearer {token}").parse().unwrap());
        h
    }

    #[tokio::test]
    async fn park_colour_is_a_coin_and_matches_the_launch_tokens() {
        // Posting an offer used to mean White every time and accepting one
        // Black every time, so a player who only joined the house bot's
        // standing offers never had the first move. Two things to hold:
        // both colours must occur, and what each side is TOLD must be the seat
        // its launch token actually drives — a colour that disagreed with the
        // token would open the board on the wrong side of a staked game.
        let (state, _c, _r) = test_state();
        let mut acceptor_whites = 0;
        const N: usize = 40;

        for i in 0..N {
            // Two DISTINCT signed-in players per round. One session for both
            // ends would be refused by the same-wallet guard, which is the
            // point: a free offer needs a session on each side now.
            let poster = player(&state, i);
            let acceptor = player(&state, i + N);
            let offer_id = park_create(
                State(state.clone()),
                poster.clone(),
                Json(ParkCreateReq {
                    stake: None,
                    initial_secs: 60,
                    increment_secs: 1,
                    name: None,
                    engine: None,
                    seat: None,
                    uci_options: None,
                }),
            )
            .await
            .expect("create")
            .0
            .offer_id;

            let acc = park_accept(
                State(state.clone()),
                Path(offer_id),
                acceptor,
                Some(Json(ParkAcceptReq::default())),
            )
            .await
            .expect("accept")
            .0;

            let posted = park_get(State(state.clone()), Path(offer_id), poster)
                .await
                .expect("offer")
                .0;
            let poster_color = posted.color.expect("a matched offer reports a colour");
            assert_ne!(
                poster_color, acc.color,
                "the two seats can't share a colour"
            );

            for (token, want) in [
                (acc.token.expect("acceptor's token"), acc.color.as_str()),
                (posted.token.expect("poster's token"), poster_color.as_str()),
            ] {
                let (game, seat) = state.token_seat(&token).expect("token is registered");
                assert_eq!(game, acc.game_id);
                let seat = match seat {
                    Color::White => "white",
                    Color::Black => "black",
                };
                assert_eq!(seat, want, "the colour reported must be the token's seat");
            }
            if acc.color == "white" {
                acceptor_whites += 1;
            }
        }

        // A fair coin over 40 pairings: an all-one-colour run is ~2^-39.
        assert!(
            acceptor_whites > 0 && acceptor_whites < N,
            "colour must vary across games, got {acceptor_whites}/{N} white acceptors"
        );
    }

    #[tokio::test]
    async fn queue_colour_is_a_coin() {
        // Same bug on the queue side: the player already waiting took White
        // against every arrival, so a bot parked in the queue never played
        // Black. Both tickets are checked, since they are written separately.
        let (state, _c, _r) = test_state();
        let mut first_whites = 0;
        const N: usize = 40;

        for i in 0..N {
            let req = || QueueReq {
                stake: None,
                initial_secs: 60,
                increment_secs: 1,
                session_id: None,
                name: None,
                engine: None,
                seat: None,
                uci_options: None,
            };
            // Two distinct signed-in players, as in the park test above: the
            // queue requires a session on every tier now, free included.
            let a = queue_join(State(state.clone()), player(&state, i), Json(req()))
                .await
                .expect("A join")
                .0
                .ticket_id;
            let b = queue_join(State(state.clone()), player(&state, i + N), Json(req()))
                .await
                .expect("B join")
                .0
                .ticket_id;

            let ta = queue_get(State(state.clone()), Path(a), HeaderMap::new())
                .await
                .expect("ticket")
                .0;
            let tb = queue_get(State(state.clone()), Path(b), HeaderMap::new())
                .await
                .expect("ticket")
                .0;
            assert_eq!(ta.status, "matched");
            assert_eq!(tb.status, "matched");
            let (ca, cb) = (ta.color.expect("A colour"), tb.color.expect("B colour"));
            assert_ne!(ca, cb, "the two seats can't share a colour");

            for (t, want) in [(ta.token, ca.as_str()), (tb.token, cb.as_str())] {
                let (_, seat) = state.token_seat(&t.expect("browser seat's token")).unwrap();
                let seat = match seat {
                    Color::White => "white",
                    Color::Black => "black",
                };
                assert_eq!(seat, want, "the colour reported must be the token's seat");
            }
            if ca == "white" {
                first_whites += 1;
            }
        }

        assert!(
            first_whites > 0 && first_whites < N,
            "colour must vary across games, got {first_whites}/{N} white for the waiter"
        );
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
        GameOutcome {
            game_id,
            winner,
            plies,
            white_showed_up: true,
            black_showed_up: true,
        }
    }

    #[test]
    fn gauntlet_auto_stops_when_a_seat_forfeits_without_moving() {
        let lobby = Lobby::default();

        // Black seat lost having never moved (White moved once → ply 1): dead
        // engine, so the session auto-stops instead of bleeding the stake.
        let black_sid = running_session(&lobby, Some("1000000"));
        let g1 = Uuid::new_v4();
        lobby
            .game_to_gauntlet
            .lock()
            .insert(g1, vec![(black_sid, Color::Black)]);
        lobby.record_outcome(&outcome(g1, Some(Color::White), 1));

        // White seat lost having never moved (a no-show forfeit → ply 0).
        let white_sid = running_session(&lobby, Some("1000000"));
        let g2 = Uuid::new_v4();
        lobby
            .game_to_gauntlet
            .lock()
            .insert(g2, vec![(white_sid, Color::White)]);
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
        lobby
            .game_to_gauntlet
            .lock()
            .insert(gid, vec![(sid, Color::Black)]);
        lobby.record_outcome(&outcome(gid, Some(Color::White), 42));

        let g = lobby.gauntlets.lock();
        let s = g.get(&sid).unwrap();
        assert_eq!(s.losses, 1);
        assert_eq!(
            s.status, "running",
            "a genuine loss must not stop the gauntlet"
        );
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
        lobby.game_to_gauntlet.lock().insert(
            gid,
            vec![(white_sid, Color::White), (black_sid, Color::Black)],
        );
        lobby.record_outcome(&GameOutcome {
            game_id: gid,
            winner: None,
            plies: 0,
            white_showed_up: true,
            black_showed_up: false,
        });
        {
            let g = lobby.gauntlets.lock();
            assert_eq!(
                g.get(&white_sid).unwrap().status,
                "running",
                "the seat that showed up is spared"
            );
            assert_eq!(
                g.get(&black_sid).unwrap().status,
                "stopped",
                "the no-show seat stops"
            );
        }

        // A real drawn game (both played, plies > 0) never stops.
        let live_sid = running_session(&lobby, None);
        let g2 = Uuid::new_v4();
        lobby
            .game_to_gauntlet
            .lock()
            .insert(g2, vec![(live_sid, Color::White)]);
        lobby.record_outcome(&outcome(g2, None, 40));
        assert_eq!(
            lobby.gauntlets.lock().get(&live_sid).unwrap().status,
            "running"
        );
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
        let _ = queue_join(
            State(state.clone()),
            player(&state, 1),
            Json(req(Some(sid))),
        )
        .await
        .expect("first join waits");
        assert!(state.0.rooms.lock().is_empty());

        // The session stops (owner-stop, or auto-stop after a no-move forfeit).
        state.0.lobby.gauntlets.lock().get_mut(&sid).unwrap().status = "stopped".into();

        // An opponent joins the same tier and pops the stopped session's stale
        // ticket — the pair-time re-check must drop it, not open a new game.
        let _ = queue_join(State(state.clone()), player(&state, 2), Json(req(None)))
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
        let _ = queue_join(State(state.clone()), player(&state, 1), Json(browser()))
            .await
            .expect("p1");
        let r2 = queue_join(State(state.clone()), player(&state, 2), Json(browser()))
            .await
            .expect("p2");
        let tr = queue_get(State(state.clone()), Path(r2.0.ticket_id), HeaderMap::new())
            .await
            .expect("ticket")
            .0;
        assert_eq!(tr.status, "matched");
        assert!(tr.token.is_some(), "a browser seat gets a launch token");
        assert_eq!(tr.seat.as_deref(), Some("browser"));
    }

    /// Two signed-in players, no stake anywhere: both wallets must reach the
    /// game. They are what `create_game` writes to `games.white_wallet` /
    /// `black_wallet`, and a game with neither is a game that never appears in
    /// either player's history, record or rating. The live snapshot is the only
    /// place to observe it without a DB, and it is written from the same array.
    #[tokio::test]
    async fn a_casual_park_game_keeps_both_players_wallets() {
        let (state, _c, _r) = test_state();
        let poster = "0xaa11111111111111111111111111111111111111";
        let acceptor = "0xbb22222222222222222222222222222222222222";
        let pt = state.0.auth.mint_session(poster);
        let at = state.0.auth.mint_session(acceptor);

        let offer = park_create(
            State(state.clone()),
            bearer(&pt),
            Json(ParkCreateReq {
                stake: None, // <- casual
                initial_secs: 60,
                increment_secs: 1,
                name: None,
                engine: None,
                seat: None,
                uci_options: None,
            }),
        )
        .await
        .expect("offer posted")
        .0;

        let joined = park_accept(
            State(state.clone()),
            Path(offer.offer_id),
            bearer(&at),
            None,
        )
        .await
        .expect("offer accepted")
        .0;

        let live = state.0.live_games.lock();
        let g = live.get(&joined.game_id).expect("game exists");
        // Which of them got White is a coin flip (`seats`), so assert on the
        // pair rather than on the seats — what matters here is that BOTH
        // wallets reached the game, not who moves first.
        let mut got = [g.white.as_deref(), g.black.as_deref()];
        got.sort();
        assert_eq!(
            got,
            [Some(poster), Some(acceptor)],
            "both wallets are seated"
        );
        assert_eq!(g.stake, None, "and none of this needed a stake");
    }

    /// The other half of the same invariant: a stale bearer must not quietly
    /// seat a signed-in player as a stranger.
    #[tokio::test]
    async fn a_dead_session_is_rejected_rather_than_seated_anonymously() {
        let (state, _c, _r) = test_state();
        let pt = state
            .0
            .auth
            .mint_session("0xaa11111111111111111111111111111111111111");
        let offer = park_create(
            State(state.clone()),
            bearer(&pt),
            Json(ParkCreateReq {
                stake: None,
                initial_secs: 60,
                increment_secs: 1,
                name: None,
                engine: None,
                seat: None,
                uci_options: None,
            }),
        )
        .await
        .expect("offer posted")
        .0;

        let err = park_accept(
            State(state.clone()),
            Path(offer.offer_id),
            bearer("not-a-live-session"),
            None,
        )
        .await
        .err();
        assert_eq!(err, Some(StatusCode::UNAUTHORIZED));
        // ...and the rejected join must not have consumed the offer.
        assert_eq!(
            state
                .0
                .lobby
                .park
                .lock()
                .get(&offer.offer_id)
                .map(|o| o.status.clone()),
            Some("open".to_string())
        );
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
                    assert!(
                        seen.insert(a) && seen.insert(b),
                        "n={n}: player twice in a round"
                    );
                    let key = if a < b { (a, b) } else { (b, a) };
                    assert!(all_pairs.insert(key), "n={n}: pair {key:?} repeated");
                }
            }
            assert_eq!(all_pairs.len(), n * (n - 1) / 2, "n={n}: every pair once");
        }
    }

    #[test]
    fn bot_entrants_survive_the_durable_round_trip() {
        // An open tournament is rebuilt from its row on boot. If this round trip
        // drops a bot binding, the restart doesn't fail loudly — the entrant
        // silently becomes a browser seat and forfeits its first round to an
        // engine that was online the whole time.
        let mut bots = HashMap::new();
        bots.insert(
            "Alpha".to_string(),
            BotEntry {
                wallet: "0xaa11111111111111111111111111111111111111".into(),
                uci_options: vec![("Threads".into(), "2".into()), ("Hash".into(), "64".into())],
            },
        );
        let back = bots_from_json(&bots_json(&bots));
        assert_eq!(back.len(), 1);
        let a = back.get("Alpha").expect("bot entrant kept its player key");
        assert_eq!(a.wallet, "0xaa11111111111111111111111111111111111111");
        assert_eq!(
            a.uci_options,
            vec![
                ("Threads".to_string(), "2".to_string()),
                ("Hash".to_string(), "64".to_string())
            ],
            "UCI overrides come back with the binding"
        );
        assert!(bots_from_json(&json!({})).is_empty());
        assert!(
            bots_from_json(&json!(null)).is_empty(),
            "a legacy row without bots is empty"
        );
    }

    #[tokio::test]
    async fn tied_entrants_share_both_the_place_and_the_prize() {
        // Two gold medals on screen used to mean 65% and 25% of the pool in the
        // wallets, decided by who joined first. The table and the payout now
        // agree: level entrants share the place AND the money.
        let (state, _c, _r) = test_state();
        let tid = tourney_create(
            State(state.clone()),
            HeaderMap::new(),
            Json(TourneyCreateReq {
                name: "T".into(),
                buy_in: None,
                initial_secs: 60,
                increment_secs: 1,
                payout: None,
                admission: None,
            }),
        )
        .await
        .expect("create")
        .0
        .tournament_id;
        let entrants = seat_entrants(&state, tid, 3).await;
        {
            let mut ts = state.0.lobby.tournaments.lock();
            let t = ts.get_mut(&tid).unwrap();
            t.scores.insert(entrants[0].clone(), 2.0);
            t.scores.insert(entrants[1].clone(), 2.0); // dead level with the first
            t.scores.insert(entrants[2].clone(), 1.0);
        }

        let view = tourney_get(State(state.clone()), Path(tid), HeaderMap::new())
            .await
            .expect("view")
            .0;
        let ranks: Vec<usize> = view.standings.iter().map(|s| s.rank).collect();
        assert_eq!(ranks, vec![1, 1, 3], "level entrants share the place");
        assert!(
            view.standings[0].tied && view.standings[1].tied,
            "both level rows are flagged"
        );
        assert!(!view.standings[2].tied);
        // …and sharing the place is honest because they share the money.
        let field: Vec<(String, f64)> = view
            .standings
            .iter()
            .map(|s| (s.player.clone(), s.score))
            .collect();
        let amounts = payout_split(30_000_000, &field, &PayoutSpec::default()).expect("split");
        assert_eq!(
            amounts[0], amounts[1],
            "a shared place must mean a shared prize"
        );

        // And the table's order IS the order the pool is paid in.
        let payout_order: Vec<String> = {
            let ts = state.0.lobby.tournaments.lock();
            ranked_entrants(ts.get(&tid).unwrap())
                .into_iter()
                .map(|(p, _)| p.to_string())
                .collect()
        };
        let shown: Vec<String> = view.standings.iter().map(|s| s.player.clone()).collect();
        assert_eq!(
            shown, payout_order,
            "what a player is looking at is what the pool pays"
        );
    }

    /// Drive the REAL `payout_split` from a list of scores, under `spec`.
    fn payouts_with(scores: &[f64], buy_in: u128, spec: &PayoutSpec) -> Vec<u128> {
        let standings: Vec<(String, f64)> = scores
            .iter()
            .enumerate()
            .map(|(i, s)| (format!("p{i}"), *s))
            .collect();
        payout_split(buy_in * scores.len() as u128, &standings, spec).expect("split")
    }

    /// …under the default 65/25/10.
    fn payouts_for(scores: &[f64], buy_in: u128) -> Vec<u128> {
        payouts_with(scores, buy_in, &PayoutSpec::default())
    }

    #[test]
    fn tied_entrants_split_their_bracket_evenly() {
        const USDC: u128 = 1_000_000; // 6dp
                                      //
                                      // Two level at the top of a field of four. This used to pay 26 and 10
                                      // USDC — a 16 USDC gap for pressing Join first. The bracket is worth
                                      // 65% + 25% = 90% of a 40 USDC pool, so each takes 18.
        let p = payouts_for(&[2.0, 2.0, 1.0, 0.5], 10 * USDC);
        assert_eq!(p, vec![18 * USDC, 18 * USDC, 4 * USDC, 0]);
        assert_eq!(
            p.iter().sum::<u128>(),
            40 * USDC,
            "the whole pool is still paid out"
        );

        // Everyone level: nobody out-performed anybody, so nobody is paid more.
        let p = payouts_for(&[1.5, 1.5, 1.5, 1.5], 10 * USDC);
        assert_eq!(
            p,
            vec![10 * USDC; 4],
            "an all-draw field returns every buy-in"
        );
        assert_eq!(p.iter().sum::<u128>(), 40 * USDC);

        // A tie spanning into the zero-weight tail still shares what it is worth.
        let p = payouts_for(&[3.0, 1.0, 1.0, 1.0, 1.0], 10 * USDC);
        assert_eq!(p[0], 32_500_000, "outright winner keeps 65%");
        assert_eq!(
            &p[1..],
            &[4_375_000; 4],
            "the 25%+10% bracket splits four ways"
        );
        assert_eq!(p.iter().sum::<u128>(), 50 * USDC);

        // No ties: unchanged from before.
        let p = payouts_for(&[3.0, 2.0, 1.0, 0.0], 10 * USDC);
        assert_eq!(p, vec![26 * USDC, 10 * USDC, 4 * USDC, 0]);
    }

    #[test]
    fn a_creator_defined_structure_replaces_the_default() {
        const USDC: u128 = 1_000_000;
        let field = [3.0, 2.0, 1.0, 0.0];

        // The default is unchanged for anyone who doesn't ask.
        assert_eq!(
            payouts_for(&field, 10 * USDC),
            vec![26 * USDC, 10 * USDC, 4 * USDC, 0]
        );

        let wta = PayoutSpec { bps: vec![10_000] };
        assert_eq!(
            payouts_with(&field, 10 * USDC, &wta),
            vec![40 * USDC, 0, 0, 0],
            "winner takes all"
        );

        let flat = PayoutSpec {
            bps: vec![2_500; 4],
        };
        assert_eq!(
            payouts_with(&field, 10 * USDC, &flat),
            vec![10 * USDC; 4],
            "a flat field returns every buy-in"
        );

        let split = PayoutSpec {
            bps: vec![5_000, 3_000, 2_000],
        };
        let p = payouts_with(&field, 10 * USDC, &split);
        assert_eq!(p, vec![20 * USDC, 12 * USDC, 8 * USDC, 0]);
        assert_eq!(p.iter().sum::<u128>(), 40 * USDC, "the whole pool, always");
    }

    #[test]
    fn a_structure_wider_than_the_field_still_pays_the_whole_pool() {
        const USDC: u128 = 1_000_000;
        // A 50/30/20 event only two entrants turn up for. Third place's 20% is
        // redistributed across the places that exist, in proportion (5:3) —
        // dropping it would leave the pool a fifth short, and the contract
        // rakes `pool - sum(payouts)` straight to the fee recipient. A thin
        // field must not quietly become house revenue.
        let spec = PayoutSpec {
            bps: vec![5_000, 3_000, 2_000],
        };
        let p = payouts_with(&[1.0, 0.0], 10 * USDC, &spec);
        assert_eq!(p, vec![12_500_000, 7_500_000], "5/8 and 3/8 of the pool");
        assert_eq!(p.iter().sum::<u128>(), 20 * USDC, "no rake on a thin field");

        // And the pool still lands exactly, whatever the structure or field.
        for n in 1..=8usize {
            for bps in [
                vec![10_000],
                vec![5_000, 3_000, 2_000],
                vec![2_500; 4],
                PayoutSpec::default().bps,
            ] {
                let spec = PayoutSpec { bps };
                spec.validate().expect("fixture is valid");
                let scores: Vec<f64> = (0..n).map(|i| (n - i) as f64 * 0.5).collect();
                let buy_in = 3 * USDC + 7; // divides badly on purpose
                let p = payouts_with(&scores, buy_in, &spec);
                assert_eq!(
                    p.iter().sum::<u128>(),
                    buy_in * n as u128,
                    "n={n} spec={:?}: whole pool distributed",
                    spec.bps
                );
            }
        }
    }

    #[test]
    fn unpayable_payout_structures_are_rejected() {
        assert!(PayoutSpec::default().validate().is_ok());
        assert!(PayoutSpec { bps: vec![10_000] }.validate().is_ok());
        assert!(PayoutSpec {
            bps: vec![2_500; 4]
        }
        .validate()
        .is_ok());
        assert!(
            PayoutSpec {
                bps: vec![10_000, 0]
            }
            .validate()
            .is_ok(),
            "an explicit zero tail is a structure, not an error"
        );

        assert!(
            PayoutSpec { bps: vec![] }.validate().is_err(),
            "pays nobody"
        );
        assert!(
            PayoutSpec {
                bps: vec![5_000, 3_000]
            }
            .validate()
            .is_err(),
            "sums to 8000 — the missing fifth would be raked to the house, silently"
        );
        assert!(
            PayoutSpec {
                bps: vec![6_000, 5_000]
            }
            .validate()
            .is_err(),
            "sums past the pool"
        );
        assert!(
            PayoutSpec {
                bps: vec![3_000, 7_000]
            }
            .validate()
            .is_err(),
            "second place paid more than first is a typo, not a design"
        );
        assert!(
            PayoutSpec {
                bps: vec![1; MAX_TOURNAMENT_PLAYERS + 1]
            }
            .validate()
            .is_err(),
            "more places than a field can hold"
        );
    }

    #[tokio::test]
    async fn tourney_create_rejects_an_unpayable_structure() {
        // Rejected at CREATE, before a buy-in tournament opens its onchain pool
        // — a structure that only failed at settlement would already have
        // locked every entrant's money behind a 24h claimRefund.
        let (state, _c, _r) = test_state();
        let bad = tourney_create(
            State(state.clone()),
            HeaderMap::new(),
            Json(TourneyCreateReq {
                name: "T".into(),
                buy_in: None,
                initial_secs: 60,
                increment_secs: 1,
                payout: Some(PayoutSpec {
                    bps: vec![5_000, 3_000],
                }),
                admission: None,
            }),
        )
        .await;
        assert!(matches!(bad, Err(StatusCode::BAD_REQUEST)));
        assert!(
            state.0.lobby.tournaments.lock().is_empty(),
            "nothing was created"
        );
    }

    #[test]
    fn a_payout_structure_survives_the_durable_round_trip() {
        // Same reasoning as `bot_entrants_survive_the_durable_round_trip`, but
        // this one is worse when it breaks: a tournament rehydrated with the
        // default structure pays its field a table it never agreed to, and
        // nothing looks wrong — the standings are right and the money moves.
        let spec = PayoutSpec {
            bps: vec![5_000, 3_000, 2_000],
        };
        let v = serde_json::to_value(&spec).expect("serialize");
        assert_eq!(
            v,
            json!({ "bps": [5000, 3000, 2000] }),
            "the shape migration 0019 stores"
        );
        assert_eq!(
            serde_json::from_value::<PayoutSpec>(v).expect("deserialize"),
            spec
        );

        // The migration's DEFAULT reproduces the previously hardcoded split, so
        // rows written before the column existed settle exactly as they would
        // have (bar the heads-up case, which was special-cased at 70/30).
        assert_eq!(
            serde_json::from_value::<PayoutSpec>(json!({ "bps": [6500, 2500, 1000] })).unwrap(),
            PayoutSpec::default()
        );
    }

    /// Create a casual tournament with the given admission policy, organized by
    /// `organizer` (whose bearer token is returned alongside).
    async fn gated_tournament(state: &AppState, tok: &str, admission: Admission) -> Uuid {
        tourney_create(
            State(state.clone()),
            bearer(tok),
            Json(TourneyCreateReq {
                name: "Gated".into(),
                buy_in: None,
                initial_secs: 60,
                increment_secs: 1,
                payout: None,
                admission: Some(admission),
            }),
        )
        .await
        .expect("create")
        .0
        .tournament_id
    }

    fn join_with(invite: Option<&str>) -> JoinReq {
        JoinReq {
            seat: None,
            uci_options: None,
            engine: None,
            invite: invite.map(str::to_string),
        }
    }

    #[tokio::test]
    async fn a_gated_tournament_needs_someone_who_can_open_the_gate() {
        // Minting invites and deciding requests are both organizer-only, so an
        // anonymously-created gated tournament would refuse every join forever.
        let (state, _c, _r) = test_state();
        for admission in [Admission::Invite, Admission::Approval] {
            let r = tourney_create(
                State(state.clone()),
                HeaderMap::new(), // no session
                Json(TourneyCreateReq {
                    name: "Nobody's".into(),
                    buy_in: None,
                    initial_secs: 60,
                    increment_secs: 1,
                    payout: None,
                    admission: Some(admission),
                }),
            )
            .await;
            assert!(matches!(r, Err(StatusCode::UNAUTHORIZED)), "{admission:?}");
        }
        // An open one still needs no organizer at all.
        assert!(tourney_create(
            State(state.clone()),
            HeaderMap::new(),
            Json(TourneyCreateReq {
                name: "Anyone's".into(),
                buy_in: None,
                initial_secs: 60,
                increment_secs: 1,
                payout: None,
                admission: None,
            }),
        )
        .await
        .is_ok());
    }

    #[tokio::test]
    async fn an_invite_code_admits_exactly_one_entrant() {
        let (state, _c, _r) = test_state();
        let org = "0xaa11111111111111111111111111111111111111";
        let tok = state.0.auth.mint_session(org);
        let alice = test_wallet(1);
        let bob = test_wallet(2);
        let alice_tok = state.0.auth.mint_session(&alice);
        let bob_tok = state.0.auth.mint_session(&bob);
        let tid = gated_tournament(&state, &tok, Admission::Invite).await;

        // No code, no entry — checked before the session is, so an anonymous
        // caller is still told it is the gate refusing them and not the door.
        assert_eq!(
            join_code(
                &tourney_join(
                    State(state.clone()),
                    Path(tid),
                    bearer(&alice_tok),
                    Json(join_with(None)),
                )
                .await
            ),
            StatusCode::FORBIDDEN
        );
        // A code nobody minted, likewise.
        assert_eq!(
            join_code(
                &tourney_join(
                    State(state.clone()),
                    Path(tid),
                    bearer(&alice_tok),
                    Json(join_with(Some("deadbeef"))),
                )
                .await
            ),
            StatusCode::FORBIDDEN
        );

        // Only the organizer may mint.
        assert!(matches!(
            tourney_invites_mint(
                State(state.clone()),
                Path(tid),
                HeaderMap::new(),
                Json(MintInvitesReq { count: 1 }),
            )
            .await,
            Err(StatusCode::FORBIDDEN)
        ));
        let codes = tourney_invites_mint(
            State(state.clone()),
            Path(tid),
            bearer(&tok),
            Json(MintInvitesReq { count: 2 }),
        )
        .await
        .expect("mint")
        .0;
        assert_eq!(codes.len(), 2);
        let code = codes[0].code.clone();

        assert_eq!(
            join_code(
                &tourney_join(
                    State(state.clone()),
                    Path(tid),
                    bearer(&alice_tok),
                    Json(join_with(Some(&code))),
                )
                .await
            ),
            StatusCode::OK
        );
        // Single use: the same code again is refused.
        assert_eq!(
            join_code(
                &tourney_join(
                    State(state.clone()),
                    Path(tid),
                    bearer(&bob_tok),
                    Json(join_with(Some(&code))),
                )
                .await
            ),
            StatusCode::FORBIDDEN
        );
        // The OTHER code still works — burning one must not burn the batch.
        assert_eq!(
            join_code(
                &tourney_join(
                    State(state.clone()),
                    Path(tid),
                    bearer(&bob_tok),
                    Json(join_with(Some(&codes[1].code))),
                )
                .await
            ),
            StatusCode::OK
        );

        let listed = tourney_invites_list(State(state.clone()), Path(tid), bearer(&tok))
            .await
            .expect("list")
            .0;
        let used: Vec<_> = listed.iter().filter_map(|r| r.used_by.clone()).collect();
        assert_eq!(used.len(), 2, "both codes record who spent them");
        assert!(used.contains(&alice) && used.contains(&bob));
    }

    #[tokio::test]
    async fn a_failed_join_hands_its_invite_code_back() {
        // The code is reserved BEFORE the join runs (so two joins can't race one
        // code), which means a join that then fails has to return it — otherwise
        // a join that dies for any other reason silently costs the organizer a
        // code. The failure used here is the one a real client hits: a session
        // that expired between opening the invite link and spending it.
        let (state, _c, _r) = test_state();
        let org = "0xaa11111111111111111111111111111111111111";
        let tok = state.0.auth.mint_session(org);
        let carol = test_wallet(3);
        let carol_tok = state.0.auth.mint_session(&carol);
        let tid = gated_tournament(&state, &tok, Admission::Invite).await;
        let codes = tourney_invites_mint(
            State(state.clone()),
            Path(tid),
            bearer(&tok),
            Json(MintInvitesReq { count: 1 }),
        )
        .await
        .expect("mint")
        .0;

        assert_eq!(
            join_code(
                &tourney_join(
                    State(state.clone()),
                    Path(tid),
                    bearer("expired-token"),
                    Json(join_with(Some(&codes[0].code))),
                )
                .await
            ),
            StatusCode::UNAUTHORIZED
        );
        // …and the code is spendable by a signed-in entrant.
        assert_eq!(
            join_code(
                &tourney_join(
                    State(state.clone()),
                    Path(tid),
                    bearer(&carol_tok),
                    Json(join_with(Some(&codes[0].code))),
                )
                .await
            ),
            StatusCode::OK,
            "the code was handed back, not burned"
        );
    }

    #[tokio::test]
    async fn approval_precedes_the_join_and_a_rejection_sticks() {
        let (state, _c, _r) = test_state();
        let org = "0xaa11111111111111111111111111111111111111";
        let alice = "0xbb22222222222222222222222222222222222222";
        let org_tok = state.0.auth.mint_session(org);
        let alice_tok = state.0.auth.mint_session(alice);
        let tid = gated_tournament(&state, &org_tok, Admission::Approval).await;

        // Approval is keyed on the wallet, so an anonymous join can't be decided
        // on at all.
        assert_eq!(
            join_code(
                &tourney_join(
                    State(state.clone()),
                    Path(tid),
                    HeaderMap::new(),
                    Json(join_with(None)),
                )
                .await
            ),
            StatusCode::UNAUTHORIZED
        );
        // Signed in but never asked.
        assert_eq!(
            join_code(
                &tourney_join(
                    State(state.clone()),
                    Path(tid),
                    bearer(&alice_tok),
                    Json(join_with(None)),
                )
                .await
            ),
            StatusCode::FORBIDDEN
        );

        // Ask. No money moves here — that IS the two-phase join.
        assert_eq!(
            tourney_request(State(state.clone()), Path(tid), bearer(&alice_tok))
                .await
                .expect("request"),
            StatusCode::ACCEPTED
        );
        assert_eq!(
            join_code(
                &tourney_join(
                    State(state.clone()),
                    Path(tid),
                    bearer(&alice_tok),
                    Json(join_with(None)),
                )
                .await
            ),
            StatusCode::FORBIDDEN,
            "pending is refused like any other not-approved state — and NOT with a \
             2xx, which `fetch` would report to the applicant as a successful join"
        );

        // Only the organizer decides.
        assert!(matches!(
            tourney_request_decide(
                State(state.clone()),
                Path((tid, alice.into())),
                bearer(&alice_tok),
                Json(DecideReq { approve: true }),
            )
            .await,
            Err(StatusCode::FORBIDDEN)
        ));
        // Reject first, and check the applicant can't clear it by re-asking.
        tourney_request_decide(
            State(state.clone()),
            Path((tid, alice.into())),
            bearer(&org_tok),
            Json(DecideReq { approve: false }),
        )
        .await
        .expect("reject");
        let _ = tourney_request(State(state.clone()), Path(tid), bearer(&alice_tok)).await;
        let rows = tourney_requests_list(State(state.clone()), Path(tid), bearer(&org_tok))
            .await
            .expect("list")
            .0;
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].state,
            ApprovalState::Rejected,
            "re-requesting must not launder a rejection"
        );
        assert_eq!(
            join_code(
                &tourney_join(
                    State(state.clone()),
                    Path(tid),
                    bearer(&alice_tok),
                    Json(join_with(None)),
                )
                .await
            ),
            StatusCode::FORBIDDEN
        );

        // Approve, and the same join now lands.
        tourney_request_decide(
            State(state.clone()),
            Path((tid, alice.into())),
            bearer(&org_tok),
            Json(DecideReq { approve: true }),
        )
        .await
        .expect("approve");
        assert_eq!(
            join_code(
                &tourney_join(
                    State(state.clone()),
                    Path(tid),
                    bearer(&alice_tok),
                    Json(join_with(None)),
                )
                .await
            ),
            StatusCode::OK
        );

        // The detail view tells the caller where they stand.
        let view = tourney_get(State(state.clone()), Path(tid), bearer(&alice_tok))
            .await
            .expect("view")
            .0;
        assert_eq!(view.admission, Admission::Approval);
        assert_eq!(view.my_admission, Some(ApprovalState::Approved));
        // …and says nothing about anyone else to an anonymous caller.
        let anon = tourney_get(State(state.clone()), Path(tid), HeaderMap::new())
            .await
            .expect("view")
            .0;
        assert_eq!(anon.my_admission, None);
    }

    #[tokio::test]
    async fn only_the_organizer_sees_the_unspent_codes() {
        // An unused code IS the credential. Listing them publicly would make an
        // invite-only tournament open to anyone who read the lobby.
        let (state, _c, _r) = test_state();
        let org = "0xaa11111111111111111111111111111111111111";
        let other = "0xcc33333333333333333333333333333333333333";
        let tok = state.0.auth.mint_session(org);
        let other_tok = state.0.auth.mint_session(other);
        let tid = gated_tournament(&state, &tok, Admission::Invite).await;
        let secret = tourney_invites_mint(
            State(state.clone()),
            Path(tid),
            bearer(&tok),
            Json(MintInvitesReq { count: 1 }),
        )
        .await
        .expect("mint")
        .0[0]
            .code
            .clone();

        for hdr in [HeaderMap::new(), bearer(&other_tok)] {
            assert!(matches!(
                tourney_invites_list(State(state.clone()), Path(tid), hdr).await,
                Err(StatusCode::FORBIDDEN)
            ));
        }
        assert!(
            tourney_invites_list(State(state.clone()), Path(tid), bearer(&tok))
                .await
                .is_ok()
        );
        // The public view never carries them either.
        let view = tourney_get(State(state.clone()), Path(tid), HeaderMap::new())
            .await
            .expect("view")
            .0;
        let json = serde_json::to_string(&view).unwrap();
        assert!(
            !json.contains(&secret),
            "the code leaked into the public view: {json}"
        );
        // The MODE is public (a client has to know to ask for a code); the codes
        // themselves are not.
        assert_eq!(view.admission, Admission::Invite);
    }

    #[test]
    fn an_in_flight_invite_reservation_is_reclaimed_on_restart() {
        // A code is reserved BEFORE the join runs, as the empty-string
        // sentinel, so two joins can't race one code. If the process dies in
        // that window the reservation is what's persisted — and nothing is in
        // flight after a restart, so a code left that way is spent by nobody,
        // forever. This is the reclaim `recover_tournaments` applies; the
        // mapping is asserted here because the rehydrate path itself needs a
        // database.
        let stored: HashMap<String, Option<String>> = serde_json::from_value(json!({
            "spent": "alice",
            "reserved": "",
            "fresh": null,
        }))
        .unwrap();
        let reclaimed: HashMap<String, Option<String>> = stored
            .into_iter()
            .map(|(code, used)| (code, used.filter(|u| !u.is_empty())))
            .collect();

        assert_eq!(
            reclaimed.get("spent"),
            Some(&Some("alice".into())),
            "a genuinely spent code stays spent"
        );
        assert_eq!(
            reclaimed.get("reserved"),
            Some(&None),
            "an in-flight reservation is handed back, not burned"
        );
        assert_eq!(
            reclaimed.get("fresh"),
            Some(&None),
            "an unused code is untouched"
        );
    }

    #[tokio::test]
    async fn the_pool_refresh_is_bounded_and_rotates() {
        // `max_lobby_tournaments` defaults to 256 and these are sequential
        // awaited RPC calls, so an unbounded sweep outruns its own interval and
        // becomes permanent load on the RPC the oracle settles with. Off-chain
        // the task must do nothing at all, and the cursor must advance rather
        // than re-reading the same head forever.
        let (state, _c, _r) = test_state();
        assert!(
            !state.0.settlement.is_onchain(),
            "the log sink stands in for 'no chain configured'"
        );
        assert_eq!(
            refresh_pools(&state, 0).await,
            0,
            "nothing to do without a chain — and no RPC attempted"
        );

        // The rotation itself. A lobby larger than one batch must be covered in
        // turn: never more than a batch per tick, and never the same head twice
        // while the tail goes unread.
        let n = POOL_REFRESH_BATCH + 5;
        let ids: Vec<Uuid> = (0..n).map(|_| Uuid::new_v4()).collect();

        let (first, cursor) = refresh_batch(&ids, 0);
        assert_eq!(
            first.len(),
            POOL_REFRESH_BATCH,
            "one batch per tick, no more"
        );
        assert_eq!(first[0], ids[0]);
        assert_eq!(cursor, POOL_REFRESH_BATCH);

        // The next tick starts where that stopped, and wraps past the end.
        let (second, _) = refresh_batch(&ids, cursor);
        assert_eq!(
            second[0], ids[POOL_REFRESH_BATCH],
            "resumes, doesn't restart"
        );
        assert_eq!(second[5], ids[0], "and wraps around to the front");

        // Every id is reached within ceil(n / batch) ticks — the property that
        // makes a bounded sweep still a complete one.
        let mut seen: std::collections::HashSet<Uuid> = std::collections::HashSet::new();
        let mut c = 0;
        for _ in 0..n.div_ceil(POOL_REFRESH_BATCH) {
            let (b, next) = refresh_batch(&ids, c);
            seen.extend(b);
            c = next;
        }
        assert_eq!(
            seen.len(),
            n,
            "every pool refreshed within one full rotation"
        );

        // Degenerate inputs must not panic or divide by zero.
        assert_eq!(refresh_batch(&[], 7), (Vec::new(), 0));
        let one = vec![ids[0]];
        assert_eq!(refresh_batch(&one, 99), (one.clone(), 0));
    }

    #[test]
    fn the_admission_policy_survives_the_durable_round_trip() {
        // A gated tournament that rehydrates as `open` is a closed door that
        // silently stopped existing — and losing `invites` re-opens every code
        // that had already been spent.
        assert_eq!(
            serde_json::to_value(Admission::Approval).unwrap(),
            json!("approval")
        );
        assert_eq!(
            serde_json::to_value(Admission::Open).unwrap(),
            json!("open")
        );
        assert_eq!(
            serde_json::from_value::<Admission>(json!("invite")).unwrap(),
            Admission::Invite
        );
        // The column default is what a pre-0018 row carries, and it must mean
        // "ungated" — those tournaments never had a gate.
        assert_eq!(
            serde_json::from_value::<Admission>(json!("open")).unwrap(),
            Admission::default()
        );

        let invites: HashMap<String, Option<String>> =
            serde_json::from_value(json!({ "abc": "alice", "def": null })).unwrap();
        assert_eq!(invites.get("abc"), Some(&Some("alice".into())));
        assert_eq!(
            invites.get("def"),
            Some(&None),
            "an unspent code stays open"
        );

        let approvals: HashMap<String, ApprovalState> =
            serde_json::from_value(json!({ "0xaa": "approved", "0xbb": "rejected" })).unwrap();
        assert_eq!(approvals["0xaa"], ApprovalState::Approved);
        assert_eq!(approvals["0xbb"], ApprovalState::Rejected);
    }

    #[test]
    fn the_three_tournament_kinds_are_distinguishable() {
        // `buy_in` carries two facts at once, and every existing check reads it
        // as "is there a pool". A free-entry sponsored event is Some("0"):
        // pool yes, fee zero — which is what keeps organizer-gated start,
        // wallet-identity entrants and authenticated my-games correct for it
        // without touching any of them.
        //
        //                      has_pool  entry_fee  ladder
        //  casual  (None)         no         0      casual
        //  free    (Some "0")     YES        0      casual  ← entrant risked nothing
        //  buy-in  (Some "n")     YES        n      ranked
        assert!(!has_pool(None));
        assert!(has_pool(Some("0")));
        assert!(has_pool(Some("1000000")));

        assert_eq!(entry_fee(None), 0);
        assert_eq!(entry_fee(Some("0")), 0);
        assert_eq!(entry_fee(Some("1000000")), 1_000_000);
        // Must agree with the path that actually CHARGES the entrant, which
        // parses as U256 (`tourney_join_inner`). A plain u128 parse reads this
        // hex string as 0 while the join charges 2 USDC — so the event would be
        // charged as paid, then filed on the casual ladder and, before the
        // MIN_OPEN_ENTRY_FEE gate, waved through as "free". Same value, two
        // readers, one of them holding the money.
        assert_eq!(
            entry_fee(Some("0x1E8480")),
            2_000_000,
            "entry_fee must parse what the charging path parses"
        );
        assert_eq!(tournament_ladder(Some("0x1E8480")), Ladder::Ranked);
        // Beyond u128 still reads as 0, which fails CLOSED (casual + gated).
        let huge = U256::MAX.to_string();
        assert_eq!(entry_fee(Some(&huge)), 0);
        assert_eq!(
            rehydrated_admission(Admission::Open, Some(&huge)),
            Admission::Approval
        );

        assert_eq!(tournament_ladder(None), Ladder::Casual);
        assert_eq!(tournament_ladder(Some("1000000")), Ladder::Ranked);
        assert_eq!(
            tournament_ladder(Some("0")),
            Ladder::Casual,
            "free entry must not be ranked: two cooperating wallets could trade wins in a \
             sponsored event and farm ranked Elo at zero cost. A nominal fee is the lever."
        );
    }

    #[tokio::test]
    async fn a_sponsored_pool_is_what_the_prize_table_reads() {
        // `buy_in × entrants` stopped being the pool the moment a third party
        // could fund one — and a sponsor's transaction comes from their own
        // browser, so the server only learns of it by polling the chain.
        const USDC: u128 = 1_000_000;
        let (state, _c, _r) = test_state();
        let tid = started_tournament(&state, 4).await;
        {
            let mut ts = state.0.lobby.tournaments.lock();
            let t = ts.get_mut(&tid).unwrap();
            t.buy_in = Some("0".into()); // free entry
            t.payout = PayoutSpec {
                bps: vec![6_000, 4_000],
            };
            for (i, s) in [3.0, 2.0, 1.0, 0.0].iter().enumerate() {
                // `started_tournament` seats `seat_entrants`' wallets, in order.
                t.scores.insert(test_wallet(i), *s);
            }
            // Derived would be 0 × 4 = nothing; the chain says a sponsor put up 500.
            assert_eq!(
                pool_of(t, 4),
                Some(0),
                "before the first read, a free event looks unfunded"
            );
            t.pool = Some(500 * USDC);
            assert_eq!(pool_of(t, 4), Some(500 * USDC), "the cached figure wins");
        }

        let view = tourney_get(State(state.clone()), Path(tid), HeaderMap::new())
            .await
            .expect("view")
            .0;
        assert_eq!(
            view.pool.as_deref(),
            Some((500 * USDC).to_string().as_str())
        );
        assert_eq!(
            view.prizes,
            vec![
                (300 * USDC).to_string(),
                (200 * USDC).to_string(),
                "0".to_string(),
                "0".to_string()
            ],
            "60/40 of the SPONSORED pool, not of the (zero) entry fees"
        );

        // An overlay event: entries AND sponsorship. The cached figure covers
        // both, where the derived one would only ever see the entries.
        {
            let mut ts = state.0.lobby.tournaments.lock();
            let t = ts.get_mut(&tid).unwrap();
            t.buy_in = Some((10 * USDC).to_string());
            t.pool = Some(540 * USDC); // 500 sponsored + 4 × 10 entries
            assert_eq!(pool_of(t, 4), Some(540 * USDC));
            t.pool = None;
            assert_eq!(
                pool_of(t, 4),
                Some(40 * USDC),
                "the fallback understates a sponsored pool rather than overstating it"
            );
        }
    }

    #[tokio::test]
    async fn the_prize_table_a_player_sees_is_the_one_that_pays() {
        // The view must not compute prizes its own way: a table that disagrees
        // with settlement is worse than no table, because entrants join on the
        // strength of it.
        const USDC: u128 = 1_000_000;
        let (state, _c, _r) = test_state();
        let tid = started_tournament(&state, 4).await;
        let spec = PayoutSpec {
            bps: vec![5_000, 3_000, 2_000],
        };
        {
            let mut ts = state.0.lobby.tournaments.lock();
            let t = ts.get_mut(&tid).unwrap();
            t.buy_in = Some((10 * USDC).to_string());
            t.payout = spec.clone();
            for (i, s) in [3.0, 2.0, 1.0, 0.0].iter().enumerate() {
                // `started_tournament` seats `seat_entrants`' wallets, in order.
                t.scores.insert(test_wallet(i), *s);
            }
        }

        let view = tourney_get(State(state.clone()), Path(tid), HeaderMap::new())
            .await
            .expect("view")
            .0;
        assert_eq!(view.payout, spec, "the structure is published");
        assert_eq!(view.prizes.len(), view.standings.len());

        // Exactly what settlement would compute over the same standings.
        let ranked: Vec<(String, f64)> = view
            .standings
            .iter()
            .map(|s| (s.player.clone(), s.score))
            .collect();
        let settled = payout_split(40 * USDC, &ranked, &spec).expect("split");
        assert_eq!(
            view.prizes,
            settled
                .iter()
                .map(|a| a.to_string())
                .collect::<Vec<String>>()
        );
        assert_eq!(settled.iter().sum::<u128>(), 40 * USDC);
    }

    #[test]
    fn payout_split_rejects_unranked_standings() {
        // The bracket scan is contiguous, so unranked input would pay the two
        // leaders here 65% and 10% instead of splitting 75% between them.
        // Rejected in EVERY build profile — a `debug_assert` here would vanish
        // from the release binary that handles the money.
        let unranked: Vec<(String, f64)> = [2.0, 1.0, 2.0]
            .iter()
            .enumerate()
            .map(|(i, s)| (format!("p{i}"), *s))
            .collect();
        let err = payout_split(30_000_000, &unranked, &PayoutSpec::default())
            .expect_err("must refuse to pay");
        assert!(err.to_string().contains("ranked order"), "got: {err}");
        // The sole real caller's input is accepted, so this can't fire in
        // normal operation.
        assert!(payout_split(
            30_000_000,
            &[
                ("a".to_string(), 2.0),
                ("b".to_string(), 2.0),
                ("c".to_string(), 1.0),
            ],
            &PayoutSpec::default(),
        )
        .is_ok());
    }

    #[test]
    fn a_split_bracket_never_loses_a_base_unit_to_rake() {
        // The contract rakes `pool - sum(payouts)` to the fee recipient, so an
        // indivisible split must not quietly drop remainder on the floor.
        const USDC: u128 = 1_000_000;
        for n in 1..=9usize {
            for tied in 1..=n {
                // `tied` entrants level at the top, the rest strictly below.
                let scores: Vec<f64> = (0..n)
                    .map(|i| if i < tied { 9.0 } else { (n - i) as f64 * 0.5 })
                    .collect();
                // A buy-in that divides badly by 3, 6, 7 …
                let buy_in = 3 * USDC + 1;
                let p = payouts_for(&scores, buy_in);
                assert_eq!(
                    p.iter().sum::<u128>(),
                    buy_in * n as u128,
                    "n={n} tied={tied}: whole pool distributed"
                );
                let bracket = &p[..tied];
                let (lo, hi) = (
                    bracket.iter().min().copied().unwrap(),
                    bracket.iter().max().copied().unwrap(),
                );
                assert!(
                    hi - lo <= 1,
                    "n={n} tied={tied}: level entrants differ by {} base units",
                    hi - lo
                );
            }
        }
    }

    #[test]
    fn round_robin_balances_colours() {
        // The circle method pins arr[0], so taking the left element as White in
        // every round used to give entrant 0 the first move in ALL of its games
        // — a permanent edge in an event that pays out a real pool.
        for n in 2..=9 {
            let rounds = round_robin_rounds(n);
            let mut whites = vec![0i32; n];
            let mut blacks = vec![0i32; n];
            for round in &rounds {
                for &(w, b) in round {
                    whites[w] += 1;
                    blacks[b] += 1;
                }
            }
            for p in 0..n {
                let games = whites[p] + blacks[p];
                assert!(
                    games < 2 || (whites[p] > 0 && blacks[p] > 0),
                    "n={n}: entrant {p} played {games} games all as one colour"
                );
                assert!(
                    (whites[p] - blacks[p]).abs() <= 1,
                    "n={n}: entrant {p} is {}W/{}B — colours must stay within one",
                    whites[p],
                    blacks[p]
                );
            }
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
                payout: None,
                admission: None,
            }),
        )
        .await
        .expect("create")
        .0
        .tournament_id;
        for (i, tok) in tokens.iter().enumerate() {
            let code = tourney_join(
                State(state.clone()),
                Path(tid),
                bearer(tok),
                Json(JoinReq {
                    seat: Some("bot".into()),
                    uci_options: None,
                    engine: None,
                    invite: None,
                }),
            )
            .await;
            assert_eq!(join_code(&code), StatusCode::OK, "join {i}");
        }

        // Start → dispatches round 0 only.
        let _ = tourney_start(State(state.clone()), Path(tid), HeaderMap::new())
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
        tokio::spawn(results_task(
            state.clone(),
            Arc::new(tokio::sync::Mutex::new(results_rx)),
        ));
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
            assert_eq!(
                games.len(),
                2,
                "round {round}: two real games (no spurious forfeits)"
            );
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
    async fn browser_entrants_advance_round_by_round_with_live_standings() {
        // The round-by-round dispatcher had a test for BOT entrants only, and
        // every reported "tournament games never start" was a browser field.
        // Drive three browser entrants (odd → a bye each round) through the
        // whole schedule and check that each round dispatches, the bye entrant
        // isn't dropped, and the standings a client polls track the results.
        let (state, _c, results_rx) = test_state();
        let tid = tourney_create(
            State(state.clone()),
            HeaderMap::new(),
            Json(TourneyCreateReq {
                name: "T".into(),
                buy_in: None,
                initial_secs: 60,
                increment_secs: 1,
                payout: None,
                admission: None,
            }),
        )
        .await
        .expect("create")
        .0
        .tournament_id;
        seat_entrants(&state, tid, 3).await;
        let _ = tourney_start(State(state.clone()), Path(tid), HeaderMap::new())
            .await
            .expect("start");
        tokio::spawn(results_task(
            state.clone(),
            Arc::new(tokio::sync::Mutex::new(results_rx)),
        ));
        let tx = state.0.results_tx.clone();

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

        // 3 entrants → 3 rounds of one game each (one entrant sits out per round).
        for round in 0..3 {
            let mut games = Vec::new();
            for _ in 0..500 {
                games = round_games(round);
                if games.len() == 1 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
            assert_eq!(games.len(), 1, "round {round} dispatched");
            tx.send(GameOutcome {
                game_id: games[0],
                winner: Some(Color::White),
                plies: 40,
                white_showed_up: true,
                black_showed_up: true,
            })
            .await
            .unwrap();
        }

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
        assert!(settled, "tournament settled after the last round");

        let view = tourney_get(State(state.clone()), Path(tid), HeaderMap::new())
            .await
            .expect("view")
            .0;
        assert_eq!(view.games.len(), 3, "every pairing is visible");
        assert!(view.games.iter().all(|g| g.result.is_some() && !g.forfeit));
        let total: f64 = view.standings.iter().map(|s| s.score).sum();
        assert_eq!(total, 3.0, "three decisive games distribute three points");
        // Every entrant played two games; colour balance means nobody swept as
        // White, so the ranks must actually differ.
        assert!(view.standings.iter().all(|s| s.played == 2));
        assert_eq!(view.standings[0].rank, 1);
    }

    #[tokio::test]
    async fn tournament_forfeits_a_pairing_when_a_bot_is_offline() {
        let (state, _c, _r) = test_state();
        // Two entrants; only one has an online bot. The offline one forfeits.
        let alpha = "0xaa11111111111111111111111111111111111111";
        let bravo = "0xbb22222222222222222222222222222222222222";
        let (tok_a, _rx_a) = register_bot(&state, alpha);
        // Bravo authenticates but never connects an agent.
        let tok_b = state.0.auth.mint_session(bravo);
        let tid = tourney_create(
            State(state.clone()),
            HeaderMap::new(),
            Json(TourneyCreateReq {
                name: "T".into(),
                buy_in: None,
                initial_secs: 60,
                increment_secs: 1,
                payout: None,
                admission: None,
            }),
        )
        .await
        .expect("create")
        .0
        .tournament_id;
        // Alpha joins as a bot (online); Bravo tries to join as a bot but is offline → 424.
        assert_eq!(
            join_code(
                &tourney_join(
                    State(state.clone()),
                    Path(tid),
                    bearer(&tok_a),
                    Json(JoinReq {
                        seat: Some("bot".into()),
                        uci_options: None,
                        engine: None,
                        invite: None,
                    }),
                )
                .await
            ),
            StatusCode::OK
        );
        assert_eq!(
            join_code(
                &tourney_join(
                    State(state.clone()),
                    Path(tid),
                    bearer(&tok_b),
                    Json(JoinReq {
                        seat: Some("bot".into()),
                        uci_options: None,
                        engine: None,
                        invite: None,
                    }),
                )
                .await
            ),
            StatusCode::FAILED_DEPENDENCY,
            "offline bot can't join"
        );
        // Bravo joins as a browser entrant instead.
        assert_eq!(
            join_code(
                &tourney_join(
                    State(state.clone()),
                    Path(tid),
                    bearer(&tok_b),
                    Json(JoinReq {
                        seat: None,
                        uci_options: None,
                        engine: None,
                        invite: None,
                    }),
                )
                .await
            ),
            StatusCode::OK
        );
        // Now make Alpha's bot busy so it can't be claimed at dispatch → its
        // single pairing forfeits to Bravo, the round is empty, tournament settles.
        assert!(state.0.agents.claim(alpha).is_ok());
        let _ = tourney_start(State(state.clone()), Path(tid), HeaderMap::new())
            .await
            .expect("start");
        let t = state.0.lobby.tournaments.lock();
        let t = t.get(&tid).unwrap();
        assert_eq!(t.games.len(), 0, "no game created — the pairing forfeited");
        assert_eq!(t.status, "settled");
        assert_eq!(
            t.scores.get(bravo).copied(),
            Some(1.0),
            "Bravo wins the forfeit"
        );
    }

    #[tokio::test]
    async fn lobby_list_carries_only_the_round_in_progress() {
        // The lobby list serializes EVERY tournament on a 3s poll for every
        // client. Inlining the full crosstable there put C(128,2) = 8128
        // pairings per tournament on that hot path. The list only needs the
        // round in progress — that's what tells a client its board should be
        // open — and the detail route still serves everything.
        let (state, _c, _r) = test_state();
        let tid = tourney_create(
            State(state.clone()),
            HeaderMap::new(),
            Json(TourneyCreateReq {
                name: "T".into(),
                buy_in: None,
                initial_secs: 60,
                increment_secs: 1,
                payout: None,
                admission: None,
            }),
        )
        .await
        .expect("create")
        .0
        .tournament_id;
        let entrants = seat_entrants(&state, tid, 4).await;
        let _ = tourney_start(State(state.clone()), Path(tid), HeaderMap::new())
            .await
            .expect("start");
        // Pretend an earlier round already played, so "all" and "current" differ.
        {
            let mut ts = state.0.lobby.tournaments.lock();
            let t = ts.get_mut(&tid).unwrap();
            for g in t.games.iter_mut() {
                g.round = 0;
                g.result = Some(Some(Color::White));
            }
            t.current_round = 1;
            t.games.push(TourneyGame {
                game_id: GameId::new_v4(),
                white: entrants[0].clone(),
                black: entrants[2].clone(),
                round: 1,
                result: None,
                white_token: String::new(),
                black_token: String::new(),
            });
        }

        let detail = tourney_get(State(state.clone()), Path(tid), HeaderMap::new())
            .await
            .expect("detail")
            .0;
        assert_eq!(
            detail.games.len(),
            3,
            "the detail route still serves every pairing"
        );

        let list = tourney_list(State(state.clone()), HeaderMap::new())
            .await
            .expect("list")
            .0;
        let row = list
            .iter()
            .find(|r| r.tournament_id == tid)
            .expect("in the lobby");
        assert_eq!(
            row.view.games.len(),
            1,
            "the lobby carries only the live round"
        );
        assert!(row.view.games.iter().all(|g| g.round == 1));
        // Standings are cheap and the lobby shows the leader, so they stay.
        assert_eq!(row.view.standings.len(), 4);
    }

    #[test]
    fn a_buy_in_tournament_without_an_organizer_is_not_rehydrated() {
        // Rows written before the organizer column existed can never be started
        // (only the organizer may). Putting one back in the lobby would invite
        // fresh entrants to lock USDC into a pool that can never pay out.
        assert!(
            !is_rehydratable(Some("1000000"), None),
            "unstartable buy-in row is skipped"
        );
        assert!(
            is_rehydratable(Some("1000000"), Some("0xabc")),
            "organized buy-in row is kept"
        );
        assert!(
            is_rehydratable(None, None),
            "a casual row needs no organizer — anyone may start it"
        );
        assert!(is_rehydratable(None, Some("0xabc")));
    }

    /// The Open-admission rule is re-applied on the way back from Postgres.
    ///
    /// `MIN_OPEN_ENTRY_FEE` is enforced at create, but `recover_tournaments` is a
    /// second writer into the lobby that never goes through it — and rows
    /// predating the rule are already stored. Restoring one verbatim would put a
    /// drainable event back in front of users, which is the same shape of miss
    /// as trusting an address-shaped id because the join path rejected it.
    #[test]
    fn a_cheap_pooled_event_cannot_come_back_open() {
        use Admission::*;
        // Stored Open + free/nominal entry → tightened to Approval.
        assert_eq!(rehydrated_admission(Open, Some("0")), Approval);
        assert_eq!(rehydrated_admission(Open, Some("1")), Approval);
        assert_eq!(rehydrated_admission(Open, Some("999999")), Approval);
        // At or above the threshold, Open is legitimate and survives.
        assert_eq!(rehydrated_admission(Open, Some("1000000")), Open);
        assert_eq!(rehydrated_admission(Open, Some("5000000")), Open);
        // A casual event has no pool to drain, so Open is always fine.
        assert_eq!(rehydrated_admission(Open, None), Open);
        // An already-gated event is never loosened, whatever the fee.
        assert_eq!(rehydrated_admission(Invite, Some("0")), Invite);
        assert_eq!(rehydrated_admission(Approval, Some("0")), Approval);
        assert_eq!(rehydrated_admission(Invite, Some("5000000")), Invite);
        // An unparseable fee reads as 0 and so fails CLOSED, not open.
        assert_eq!(rehydrated_admission(Open, Some("not-a-number")), Approval);
    }

    /// Rehydration re-applies the one entrant rule the join door can't.
    ///
    /// Calls the REAL `rehydrated_entrants` that `recover_tournaments` uses — an
    /// earlier version re-implemented the logic inline, so deleting the
    /// production call would have left it green.
    #[test]
    fn rehydration_re_gates_the_entrant_field() {
        let a = "0xaa11111111111111111111111111111111111111";
        let b = "0xbb22222222222222222222222222222222222222";
        let owner = "0xcc33333333333333333333333333333333333333";
        let wallets: HashMap<String, String> =
            [(a.to_string(), owner.to_string())].into_iter().collect();

        // POOLED: `entrant_wallets` must come back EMPTY. Its ids are the SIWE
        // wallets, so no writer produces an entry — and `entrant_wallet` prefers
        // one over the id, so a single stored row would rebind a paid seat's
        // settled identity and ranked Elo to an arbitrary address.
        let out = rehydrated_entrants(
            Some("1000000"),
            vec![a.to_string(), b.to_string()],
            HashMap::new(),
            wallets.clone(),
        );
        assert_eq!(out.players.len(), 2, "a paid field is never pruned");
        assert!(
            out.entrant_wallets.is_empty(),
            "a pooled tournament must carry no entrant_wallets"
        );
        // Free entry is pooled too (its ids are SIWE wallets).
        assert!(rehydrated_entrants(
            Some("0"),
            vec![a.to_string()],
            HashMap::new(),
            wallets.clone()
        )
        .entrant_wallets
        .is_empty());

        // CASUAL: nothing is dropped. Entrants are wallet-keyed here too now, so
        // a field of addresses is the NORMAL case — filtering address-shaped ids
        // would delete the whole field on the next restart, permanently.
        let out = rehydrated_entrants(
            None,
            vec![a.to_string(), b.to_string()],
            HashMap::new(),
            wallets.clone(),
        );
        assert_eq!(out.players.len(), 2, "a casual field is not pruned either");
        // ...and a legacy name-keyed binding is preserved, so an entrant seated
        // under the old model isn't locked out of the event they're already in.
        assert_eq!(out.entrant_wallets.get(a).map(String::as_str), Some(owner));
    }

    /// Case-SENSITIVE, deliberately — see `is_wallet_id`.
    ///
    /// Every id written today comes from `authed_wallet`, which lowercases, so
    /// nothing legitimate is `0X…`. A nickname persisted under the old
    /// name-keyed model could be, and matching case-insensitively would newly
    /// resolve such a nickname AS that wallet — the impersonation this predicate
    /// gates. Tightening the shape test here would loosen the security property.
    #[test]
    fn is_wallet_id_is_case_sensitive_so_a_legacy_nickname_cannot_resolve() {
        let lower = "0xdead222222222222222222222222222222222222";
        let upper = "0Xdead222222222222222222222222222222222222";
        assert!(is_wallet_id(lower));
        assert!(
            !is_wallet_id(upper),
            "a legacy `0X` nickname must not resolve as its lookalike wallet"
        );
        assert!(!is_wallet_id("Alice"));
        assert!(!is_wallet_id("0xshort"));
        assert!(!is_wallet_id(""));
    }

    #[test]
    fn a_rehydrated_buy_in_tournament_still_dispatches_ranked_games() {
        // The entry fee is the only money in a tournament, so it is the only
        // thing that can make its pairings ranked — and it has to survive a
        // restart to do it. `buy_in` is persisted and `recover_tournaments`
        // copies it back, so a rehydrated paid tournament keeps dispatching
        // ranked games instead of quietly coming back casual for its whole
        // remaining schedule.
        assert!(
            is_rehydratable(Some("1000000"), Some("0xabc")),
            "it comes back at all"
        );
        assert_eq!(tournament_ladder(Some("1000000")), Ladder::Ranked);
        assert_eq!(
            tournament_ladder(None),
            Ladder::Casual,
            "a free tournament is casual"
        );
    }

    /// Create a casual tournament with `n` browser entrants and start it.
    async fn started_tournament(state: &AppState, n: usize) -> Uuid {
        let tid = tourney_create(
            State(state.clone()),
            HeaderMap::new(),
            Json(TourneyCreateReq {
                name: "T".into(),
                buy_in: None,
                initial_secs: 60,
                increment_secs: 1,
                payout: None,
                admission: None,
            }),
        )
        .await
        .expect("create")
        .0
        .tournament_id;
        seat_entrants(state, tid, n).await;
        let _ = tourney_start(State(state.clone()), Path(tid), HeaderMap::new())
            .await
            .expect("start");
        tid
    }

    #[tokio::test]
    async fn a_drained_server_pauses_a_tournament_instead_of_scoring_phantom_draws() {
        // `dispatch_round` used to treat EVERY start_game error as "neither side
        // got to play → draw". But start_game also refuses while the maintenance
        // drain is on, and when the global room ceiling is hit. So draining
        // before a deploy — the documented safe procedure — scored every
        // remaining pairing 0.5/0.5, and because an all-forfeit round makes
        // `dispatch_from_current` advance, it cascaded through the whole
        // remaining schedule, marked the tournament complete, and settled a real
        // USDC pool on results nobody played. Permanently: the contract's
        // `AlreadySettled` makes it unrepeatable.
        let (state, _c, _r) = test_state();
        let tid = started_tournament(&state, 4).await;

        // Round 0 dispatched normally: 4 entrants = 2 games per round.
        {
            let ts = state.0.lobby.tournaments.lock();
            let t = ts.get(&tid).unwrap();
            assert_eq!(t.games.len(), 2, "round 0 dispatched");
            assert_eq!(t.rounds.len(), 3);
        }

        // Round 0 resolves, and the operator drains for a deploy in the gap.
        {
            let mut ts = state.0.lobby.tournaments.lock();
            let t = ts.get_mut(&tid).unwrap();
            for g in t.games.iter_mut() {
                g.result = Some(Some(Color::White));
            }
            t.current_round = 1;
        }
        state
            .0
            .maintenance
            .store(true, std::sync::atomic::Ordering::Relaxed);

        // This is what results_task calls when a round finishes.
        dispatch_from_current(&state, tid).await;

        {
            let ts = state.0.lobby.tournaments.lock();
            let t = ts.get(&tid).unwrap();
            assert_eq!(t.status, "paused", "parked, not advanced");
            assert!(
                t.forfeits.is_empty(),
                "a drained server must not invent forfeits: {:?}",
                t.forfeits.len()
            );
            assert!(
                t.scores.is_empty(),
                "nothing unplayed may score: {:?}",
                t.scores
            );
            assert_eq!(t.current_round, 1, "the schedule did not walk past round 1");
            assert_eq!(t.games.len(), 2, "no games beyond round 0 were created");
        }

        // Resume once the drain lifts: same schedule, same position, and the
        // round that never dispatched now does.
        state
            .0
            .maintenance
            .store(false, std::sync::atomic::Ordering::Relaxed);
        let _ = tourney_start(State(state.clone()), Path(tid), HeaderMap::new())
            .await
            .expect("resume");
        {
            let ts = state.0.lobby.tournaments.lock();
            let t = ts.get(&tid).unwrap();
            assert_eq!(t.status, "running");
            assert_eq!(t.current_round, 1, "resume does not replay played rounds");
            assert_eq!(t.rounds.len(), 3, "the schedule was not rebuilt");
            assert_eq!(t.games.len(), 4, "round 1's two games were dispatched");
            assert_eq!(t.games.iter().filter(|g| g.round == 1).count(), 2);
        }
    }

    #[tokio::test]
    async fn re_dispatching_a_round_does_not_double_create_its_games() {
        // Resume calls `dispatch_round` on a round that may already be half
        // dispatched, so it has to be idempotent per pairing — otherwise a
        // resumed round runs each surviving pairing twice, and both games score.
        let (state, _c, _r) = test_state();
        let tid = started_tournament(&state, 4).await;

        let before = {
            let ts = state.0.lobby.tournaments.lock();
            ts.get(&tid).unwrap().games.len()
        };
        assert_eq!(before, 2);

        let d = dispatch_round(&state, tid, 0).await;
        assert!(d.blocked.is_none());
        let ts = state.0.lobby.tournaments.lock();
        let t = ts.get(&tid).unwrap();
        assert_eq!(t.games.len(), 2, "the same pairings were not re-created");
        assert_eq!(
            t.round_remaining, 2,
            "round_remaining counts the round's live games, not just new ones"
        );
    }

    #[tokio::test]
    async fn casual_tournament_view_serves_standings_and_forfeits() {
        // Standings were computed for the settlement log and never exposed, so
        // "who is winning" was unanswerable from any client. They also have to
        // account for forfeited pairings — those score points but create no
        // game, so a table built from played games alone wouldn't add up.
        let (state, _c, _r) = test_state();
        let wa = "0xaa11111111111111111111111111111111111111";
        let (tok_a, _rx_a) = register_bot(&state, wa);
        let tid = tourney_create(
            State(state.clone()),
            HeaderMap::new(),
            Json(TourneyCreateReq {
                name: "T".into(),
                buy_in: None,
                initial_secs: 60,
                increment_secs: 1,
                payout: None,
                admission: None,
            }),
        )
        .await
        .expect("create")
        .0
        .tournament_id;

        // Alpha is a bot entrant, Bravo a browser entrant. Standings exist
        // before a single move is played.
        let alpha_join = tourney_join(
            State(state.clone()),
            Path(tid),
            bearer(&tok_a),
            Json(JoinReq {
                seat: Some("bot".into()),
                uci_options: None,
                engine: None,
                invite: None,
            }),
        )
        .await
        .expect("alpha joins")
        .0;
        assert_eq!(
            alpha_join.player, wa,
            "join echoes the recorded entrant id, which is the wallet"
        );
        let wb = seat_entrants(&state, tid, 1).await.remove(0);

        let view = tourney_get(State(state.clone()), Path(tid), HeaderMap::new())
            .await
            .expect("view")
            .0;
        assert_eq!(
            view.standings.len(),
            2,
            "an open tournament still has a table"
        );
        assert!(view
            .standings
            .iter()
            .all(|s| s.score == 0.0 && s.played == 0));
        assert!(
            view.standings.iter().any(|s| s.player == wa && s.bot),
            "the bot entrant is flagged"
        );

        // Busy Alpha's agent so its only pairing forfeits at dispatch.
        assert!(state.0.agents.claim(wa).is_ok());
        let _ = tourney_start(State(state.clone()), Path(tid), HeaderMap::new())
            .await
            .expect("start");

        let view = tourney_get(State(state.clone()), Path(tid), HeaderMap::new())
            .await
            .expect("view")
            .0;
        assert_eq!(
            view.games.len(),
            1,
            "the forfeited pairing is still a visible row"
        );
        assert!(view.games[0].forfeit && view.games[0].game_id.is_none());
        assert_eq!(
            view.games[0].result.as_deref(),
            Some("black"),
            "Bravo awarded it"
        );
        let bravo = view.standings.iter().find(|s| s.player == wb).unwrap();
        assert_eq!((bravo.score, bravo.played, bravo.rank), (1.0, 1, 1));
        let alpha = view.standings.iter().find(|s| s.player == wa).unwrap();
        assert_eq!((alpha.score, alpha.played, alpha.rank), (0.0, 1, 2));
    }

    #[tokio::test]
    async fn my_games_recognises_a_bot_entrant_case_insensitively() {
        // The entrant id and the id a client sends to /my-games can differ in
        // CASE. `mint_session` lowercases, so the server records a lowercase
        // wallet, while a browser reads its address from the connector — where
        // it is EIP-55 checksummed — and sends that. An exact-match bot lookup
        // therefore missed, and the server handed the browser a live seat token
        // for a game its own agent was playing.
        //
        // The query below is deliberately the checksummed form against a
        // lowercase-stored entrant. Sending the lowercase form would match
        // exactly and test nothing.
        let (state, _c, _r) = test_state();
        let wa = "0xAA11111111111111111111111111111111111111";
        let wb = "0xBB22222222222222222222222222222222222222";
        let (tok_a, _rx_a) = register_bot(&state, wa);
        let (tok_b, _rx_b) = register_bot(&state, wb);
        let tid = tourney_create(
            State(state.clone()),
            HeaderMap::new(),
            Json(TourneyCreateReq {
                name: "T".into(),
                buy_in: None,
                initial_secs: 60,
                increment_secs: 1,
                payout: None,
                admission: None,
            }),
        )
        .await
        .expect("create")
        .0
        .tournament_id;
        for tok in [&tok_a, &tok_b] {
            let _ = tourney_join(
                State(state.clone()),
                Path(tid),
                bearer(tok),
                Json(JoinReq {
                    seat: Some("bot".into()),
                    uci_options: None,
                    engine: None,
                    invite: None,
                }),
            )
            .await
            .expect("join");
        }
        let _ = tourney_start(State(state.clone()), Path(tid), HeaderMap::new())
            .await
            .expect("start");

        let mine = tourney_my_games(
            State(state.clone()),
            Path(tid),
            Query(MyGamesQuery {
                player: Some(wa.to_string()),
            }),
            HeaderMap::new(),
        )
        .await
        .expect("my games")
        .0;
        assert_eq!(mine.len(), 1, "lowercased id still finds the pairing");
        assert_eq!(mine[0].seat, "bot");
        assert!(
            mine[0].token.is_empty(),
            "a bot seat must never leak a token"
        );
    }

    /// A casual entrant can only ever be one seat, and re-joining is a no-op.
    ///
    /// This replaces a duplicate-display-name test. Two entrants could once
    /// collide on a nickname, and a later joiner reusing one would have hijacked
    /// the existing entrant's seat — hence a 409. Wallets can't collide, so the
    /// remaining question is the opposite one: the retry path (a join whose
    /// durable write failed, or a double-tapped button) must not seat the same
    /// wallet twice or answer 409 to someone who is already in.
    #[tokio::test]
    async fn a_casual_entrant_joins_once_and_re_joining_is_a_no_op() {
        let (state, _c, _r) = test_state();
        let tid = tourney_create(
            State(state.clone()),
            HeaderMap::new(),
            Json(TourneyCreateReq {
                name: "T".into(),
                buy_in: None,
                initial_secs: 60,
                increment_secs: 1,
                payout: None,
                admission: None,
            }),
        )
        .await
        .expect("create")
        .0
        .tournament_id;
        let wallet = "0xAA11111111111111111111111111111111111111";
        let tok = state.0.auth.mint_session(wallet);
        let join = |headers: HeaderMap| {
            tourney_join(
                State(state.clone()),
                Path(tid),
                headers,
                Json(JoinReq {
                    seat: None,
                    uci_options: None,
                    engine: None,
                    invite: None,
                }),
            )
        };
        assert_eq!(join_code(&join(bearer(&tok)).await), StatusCode::OK);
        assert_eq!(join_code(&join(bearer(&tok)).await), StatusCode::OK);
        // A second session for the SAME wallet is the same entrant — the id is
        // the wallet, not the session.
        let tok2 = state.0.auth.mint_session(&wallet.to_lowercase());
        assert_eq!(join_code(&join(bearer(&tok2)).await), StatusCode::OK);
        let ts = state.0.lobby.tournaments.lock();
        assert_eq!(
            ts.get(&tid).unwrap().players.len(),
            1,
            "three joins, one entrant"
        );
    }

    /// Opening a buy-in pool spends ORACLE gas while the organizer locks
    /// nothing until someone joins, and a SIWE session is free to mint — so the
    /// per-wallet cap doesn't bind an attacker. The gate ties the cost to
    /// something unmintable: the organizer must be able to cover their own
    /// buy-in. It must fail closed on a real shortfall and OPEN on an RPC
    /// error, or one flaky node locks every legitimate organizer out.
    #[tokio::test]
    async fn a_buy_in_pool_needs_the_organizer_to_be_funded() {
        let buy_in = "1000000"; // 1 USDC
        let create = |state: AppState, token: String| async move {
            tourney_create(
                State(state),
                bearer(&token),
                Json(TourneyCreateReq {
                    name: "Paid".into(),
                    buy_in: Some(buy_in.into()),
                    initial_secs: 60,
                    increment_secs: 1,
                    payout: None,
                    admission: None,
                }),
            )
            .await
            .err()
        };
        let wallet = "0xaa55555555555555555555555555555555555555";

        // Broke: refused, and no oracle gas was spent.
        let (state, _c, _r) = test_state_with_sink(Arc::new(BankrollStub(Some(0))));
        let tok = state.0.auth.mint_session(wallet);
        assert_eq!(
            create(state.clone(), tok).await,
            Some(StatusCode::PAYMENT_REQUIRED)
        );
        assert!(
            state.0.lobby.tournaments.lock().is_empty(),
            "a refused create leaves no tournament behind"
        );

        // Funded, but under the buy-in: still refused.
        let (state, _c, _r) = test_state_with_sink(Arc::new(BankrollStub(Some(999_999))));
        let tok = state.0.auth.mint_session(wallet);
        assert_eq!(
            create(state.clone(), tok).await,
            Some(StatusCode::PAYMENT_REQUIRED)
        );

        // Exactly covered: allowed (the organizer can pay their own entry).
        let (state, _c, _r) = test_state_with_sink(Arc::new(BankrollStub(Some(1_000_000))));
        let tok = state.0.auth.mint_session(wallet);
        assert_eq!(create(state.clone(), tok).await, None);
        assert_eq!(state.0.lobby.tournaments.lock().len(), 1);

        // The view call failed: fail OPEN rather than lock the feature out.
        let (state, _c, _r) = test_state_with_sink(Arc::new(BankrollStub(None)));
        let tok = state.0.auth.mint_session(wallet);
        assert_eq!(create(state.clone(), tok).await, None);

        // And a CASUAL tournament never consults a balance at all.
        let (state, _c, _r) = test_state_with_sink(Arc::new(BankrollStub(Some(0))));
        let free = tourney_create(
            State(state.clone()),
            HeaderMap::new(),
            Json(TourneyCreateReq {
                name: "Free".into(),
                buy_in: None,
                initial_secs: 60,
                increment_secs: 1,
                payout: None,
                admission: None,
            }),
        )
        .await;
        assert!(
            free.is_ok(),
            "a casual tournament costs no gas and needs no balance"
        );

        // But a FREE-ENTRY tournament is not casual: `buy_in: "0"` still opens
        // an oracle-paid onchain pool. `balance < buy_in` is vacuously false at
        // zero, so without the `max(1)` this gate would wave every unfunded
        // creator through — the hole it exists to close, reopened by a feature
        // that landed after it.
        let sponsored = tourney_create(
            State(state.clone()),
            bearer(
                &state
                    .0
                    .auth
                    .mint_session("0xaa66666666666666666666666666666666666666"),
            ),
            Json(TourneyCreateReq {
                name: "Sponsored".into(),
                buy_in: Some("0".into()),
                initial_secs: 60,
                increment_secs: 1,
                payout: None,
                // A free-entry event must be gated (see the drain guard); use
                // approval so this reaches the balance check under test.
                admission: Some(Admission::Approval),
            }),
        )
        .await;
        assert!(
            matches!(sponsored, Err(StatusCode::PAYMENT_REQUIRED)),
            "a zero-balance creator must not get a free oracle transaction, \
             free entry or not (got {:?})",
            sponsored.err()
        );
    }

    /// A free-entry (sponsor-funded) event may not be Open: entry is costless, so
    /// Open admission lets an attacker field throwaway entrants to capture the
    /// sponsor's pool with no offsetting entry fee. It must be invite- or
    /// approval-gated. A casual (no-pool) event and a real buy-in event are both
    /// still free to be Open.
    #[tokio::test]
    async fn a_free_entry_event_may_not_be_open() {
        let (state, _c, _r) = test_state_with_sink(Arc::new(BankrollStub(Some(1_000_000))));
        let org = state
            .0
            .auth
            .mint_session("0xaa77777777777777777777777777777777777777");
        let mk = |buy_in: Option<&str>, admission: Option<Admission>| {
            tourney_create(
                State(state.clone()),
                bearer(&org),
                Json(TourneyCreateReq {
                    name: "T".into(),
                    buy_in: buy_in.map(|s| s.to_string()),
                    initial_secs: 60,
                    increment_secs: 1,
                    payout: None,
                    admission,
                }),
            )
        };
        // Free-entry + Open → refused.
        assert!(
            matches!(mk(Some("0"), None).await, Err(StatusCode::BAD_REQUEST)),
            "a free-entry event must not be Open"
        );
        // A NOMINAL fee is not a fee: one base unit (0.000001 USDC) is free in
        // every way that matters, so it must not buy its way past the gate.
        assert!(
            matches!(mk(Some("1"), None).await, Err(StatusCode::BAD_REQUEST)),
            "a 1-base-unit entry must not make an event Open-able"
        );
        assert!(
            matches!(mk(Some("999999"), None).await, Err(StatusCode::BAD_REQUEST)),
            "just under the threshold is still too cheap to be Open"
        );
        // Free-entry + a gate → allowed.
        assert!(
            mk(Some("0"), Some(Admission::Invite)).await.is_ok(),
            "a gated free-entry event is fine"
        );
        // A real buy-in event may be Open (Sybils must each pay in).
        assert!(
            mk(Some("1000000"), None).await.is_ok(),
            "a paid event at the threshold may be Open"
        );
        // A casual (no-pool) event may be Open (nothing to drain).
        assert!(mk(None, None).await.is_ok(), "a casual event may be Open");
    }

    /// EVERY matchmaking door needs a session, free games included.
    ///
    /// This is one product rule with four entry points, and it used to be
    /// enforced at only some of them: a stake or a bot seat required auth, a
    /// free browser seat did not. That left a hole the web app's sign-in gate
    /// cannot close, because the gate is in the browser — anything scripting
    /// `POST /park/offers` could still put an anonymous free challenge in the
    /// same "Open challenges" table every signed-in player reads, as a row none
    /// of them could have created. It is also a seat that records no wallet, so
    /// the finished game reaches neither player's history.
    ///
    /// Deliberately NOT in this list: `POST /games`, the Test Engine sandbox,
    /// which is the one door that stays open (see `TEST_MODE` in main.rs).
    #[tokio::test]
    async fn every_free_matchmaking_door_needs_a_session() {
        let (state, _c, _r) = test_state();
        let anon = HeaderMap::new();

        let park = park_create(
            State(state.clone()),
            anon.clone(),
            Json(ParkCreateReq {
                stake: None, // free
                initial_secs: 60,
                increment_secs: 1,
                name: None,
                engine: None,
                seat: None, // browser, not a bot
                uci_options: None,
            }),
        )
        .await;
        assert_eq!(
            park.err(),
            Some(StatusCode::UNAUTHORIZED),
            "free park offer"
        );

        let queue = queue_join(
            State(state.clone()),
            anon.clone(),
            Json(QueueReq {
                stake: None,
                initial_secs: 60,
                increment_secs: 1,
                session_id: None,
                name: None,
                engine: None,
                seat: None,
                uci_options: None,
            }),
        )
        .await
        .err();
        assert_eq!(queue, Some(StatusCode::UNAUTHORIZED), "free queue tier");

        let gauntlet = gauntlet_start(
            State(state.clone()),
            anon.clone(),
            Json(GauntletStartReq {
                stake: None,
                initial_secs: 60,
                increment_secs: 1,
            }),
        )
        .await
        .err();
        assert_eq!(gauntlet, Some(StatusCode::UNAUTHORIZED), "free gauntlet");

        // Accepting is the other half of park: a game has two seats, and one
        // anonymous seat is enough to lose the game from a history — and to
        // slip past the same-wallet guard, which keys on `poster_addr`.
        let poster = player(&state, 7);
        let offer = park_create(
            State(state.clone()),
            poster,
            Json(ParkCreateReq {
                stake: None,
                initial_secs: 60,
                increment_secs: 1,
                name: None,
                engine: None,
                seat: None,
                uci_options: None,
            }),
        )
        .await
        .expect("a signed-in poster still posts")
        .0
        .offer_id;
        let accept = park_accept(
            State(state.clone()),
            Path(offer),
            anon,
            Some(Json(ParkAcceptReq::default())),
        )
        .await
        .err();
        assert_eq!(accept, Some(StatusCode::UNAUTHORIZED), "free park accept");
        // …and the rejected accept did NOT consume the offer.
        assert!(
            park_accept(
                State(state.clone()),
                Path(offer),
                player(&state, 8),
                Some(Json(ParkAcceptReq::default())),
            )
            .await
            .is_ok(),
            "a 401'd accept must leave the offer open"
        );
    }

    /// Joining is how you choose what plays your seat, so the LAST join wins in
    /// both directions.
    ///
    /// Re-joining is idempotent (the retry path for a durable write that
    /// failed), which is what makes the reverse direction reachable at all: a
    /// wallet that entered with its bot and then re-entered from the browser
    /// used to keep the binding, so every pairing still dispatched to the agent
    /// — the browser sat at a board it was never asked to play, and an agent
    /// offline at dispatch forfeited the round.
    #[tokio::test]
    async fn re_joining_from_the_browser_releases_a_bot_binding() {
        let (state, _c, _r) = test_state();
        // `mint_session` lowercases, so the entrant id the server records is the
        // lowercased wallet whatever case the client signed in with.
        let wallet = "0xAA11111111111111111111111111111111111111".to_lowercase();
        let (tok, _rx) = register_bot(&state, &wallet);
        let tid = tourney_create(
            State(state.clone()),
            HeaderMap::new(),
            Json(TourneyCreateReq {
                name: "T".into(),
                buy_in: None,
                initial_secs: 60,
                increment_secs: 1,
                payout: None,
                admission: None,
            }),
        )
        .await
        .expect("create")
        .0
        .tournament_id;
        let join = |seat: Option<&str>| {
            tourney_join(
                State(state.clone()),
                Path(tid),
                bearer(&tok),
                Json(JoinReq {
                    seat: seat.map(str::to_string),
                    uci_options: None,
                    engine: None,
                    invite: None,
                }),
            )
        };

        assert_eq!(join_code(&join(Some("bot")).await), StatusCode::OK);
        assert!(
            state
                .0
                .lobby
                .tournaments
                .lock()
                .get(&tid)
                .unwrap()
                .entrant_bots
                .contains_key(&wallet),
            "the bot entry is recorded"
        );

        assert_eq!(join_code(&join(None).await), StatusCode::OK);
        let t = state.0.lobby.tournaments.lock();
        let t = t.get(&tid).unwrap();
        assert!(
            !t.entrant_bots.contains_key(&wallet),
            "re-joining from the browser must release the agent, or every pairing \
             still dispatches to a bot the player is no longer driving"
        );
        assert_eq!(t.players.len(), 1, "and it is still one entrant");
    }

    /// A FREE tournament's games belong to the sessions that entered it, and the
    /// entrant id IS the wallet — the same identity a buy-in tournament uses.
    ///
    /// Two failures in one test. The wallet has to reach the dispatched seats,
    /// or a signed-in human in a free tournament gets no history row and no
    /// casual Elo while a bot entrant in the same tournament does. And the door
    /// has to refuse anyone without a session: while the entrant id was a string
    /// the client picked, a guest could enter under any handle, including one
    /// belonging to somebody else.
    #[tokio::test]
    async fn a_free_tournament_attributes_signed_in_entrants() {
        let (state, _c, _r) = test_state();
        let tid = tourney_create(
            State(state.clone()),
            HeaderMap::new(),
            Json(TourneyCreateReq {
                name: "Free T".into(),
                buy_in: None,
                initial_secs: 60,
                increment_secs: 1,
                payout: None,
                admission: None,
            }),
        )
        .await
        .expect("create")
        .0
        .tournament_id;
        let wa = "0xaa33333333333333333333333333333333333333";
        let wb = "0xbb44444444444444444444444444444444444444";
        let ta = state.0.auth.mint_session(wa);
        let tb = state.0.auth.mint_session(wb);
        let join = |headers: HeaderMap| {
            tourney_join(
                State(state.clone()),
                Path(tid),
                headers,
                Json(JoinReq {
                    seat: None,
                    uci_options: None,
                    engine: None,
                    invite: None,
                }),
            )
        };
        assert_eq!(join_code(&join(bearer(&ta)).await), StatusCode::OK);
        assert_eq!(join_code(&join(bearer(&tb)).await), StatusCode::OK);
        // A stale bearer must 401, and so must no bearer at all: there is no
        // longer a client-supplied name to enter anonymously under.
        assert_eq!(
            join_code(&join(bearer("dead-token")).await),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            join_code(&join(HeaderMap::new()).await),
            StatusCode::UNAUTHORIZED
        );
        // Re-joining is the retry path for a durable write that failed. It must
        // be idempotent, not a duplicate entrant and not a 409.
        assert_eq!(join_code(&join(bearer(&ta)).await), StatusCode::OK);
        {
            let ts = state.0.lobby.tournaments.lock();
            let t = ts.get(&tid).expect("tournament");
            let mut players = t.players.clone();
            players.sort();
            assert_eq!(
                players,
                vec![wa.to_string(), wb.to_string()],
                "the entrant id is the wallet, and only signed-in wallets got in"
            );
        }

        let _ = tourney_start(State(state.clone()), Path(tid), HeaderMap::new())
            .await
            .expect("start");
        let live = state.0.live_games.lock();
        let g = live
            .values()
            .next()
            .expect("round 0 dispatched the pairing");
        // Who got White is the round-robin's business; what matters is that
        // BOTH sessions' wallets reached the seats.
        let mut got = [g.white.as_deref(), g.black.as_deref()];
        got.sort();
        assert_eq!(got, [Some(wa), Some(wb)]);
    }

    /// A BUY-IN tournament's seats still carry their entrants' wallets.
    ///
    /// The other half of `ids_are_wallets`, and the one with real money behind
    /// it. A paid join never writes `entrant_wallets` — the entrant id simply IS
    /// the SIWE wallet — so `entrant_wallet`'s address-shaped fallback is the
    /// ENTIRE binding mechanism here. Flip that flag (or narrow the predicate
    /// that feeds it) and every paid tournament silently records NULL seats:
    /// no game history, no Elo, nothing to attribute a payout dispute to — with
    /// every other test still green, because the rest of them are casual.
    #[tokio::test]
    async fn a_buy_in_tournament_binds_its_entrants_wallets_to_seats() {
        let (state, _c, _r) = test_state_with_sink(Arc::new(BankrollStub(Some(50_000_000))));
        let wa = "0xaa12121212121212121212121212121212121212";
        let wb = "0xbb13131313131313131313131313131313131313";
        let ta = state.0.auth.mint_session(wa);
        let tb = state.0.auth.mint_session(wb);
        let tid = tourney_create(
            State(state.clone()),
            bearer(&ta),
            Json(TourneyCreateReq {
                name: "Paid".into(),
                buy_in: Some("2000000".into()), // 2 USDC, above MIN_OPEN_ENTRY_FEE
                initial_secs: 60,
                increment_secs: 1,
                payout: None,
                admission: None,
            }),
        )
        .await
        .expect("create")
        .0
        .tournament_id;
        for tok in [&ta, &tb] {
            let _ = tourney_join(
                State(state.clone()),
                Path(tid),
                bearer(tok),
                Json(JoinReq {
                    seat: None,
                    uci_options: None,
                    engine: None,
                    invite: None,
                }),
            )
            .await
            .expect("join");
        }
        // Sanity: the paid path really does leave `entrant_wallets` empty, so the
        // assertion below is exercising the fallback and not a stored binding.
        {
            let ts = state.0.lobby.tournaments.lock();
            let t = ts.get(&tid).expect("tournament");
            assert_eq!(t.players.len(), 2);
            assert!(
                t.entrant_wallets.is_empty(),
                "a paid join stores no explicit wallet — the id is the wallet"
            );
        }
        let _ = tourney_start(State(state.clone()), Path(tid), bearer(&ta))
            .await
            .expect("start");
        let live = state.0.live_games.lock();
        let g = live
            .values()
            .next()
            .expect("round 0 dispatched the pairing");
        let mut got = [g.white.as_deref(), g.black.as_deref()];
        got.sort();
        assert_eq!(
            got,
            [Some(wa), Some(wb)],
            "both paid seats must carry their entrant's wallet"
        );
        assert!(g.rated, "a paid tournament's pairings are ranked");
    }

    /// A casual entrant's browser launch token is theirs alone.
    ///
    /// More pointed than it used to be: a casual entrant id IS a wallet now, so
    /// the id is not a nickname an attacker has to learn — it is an address
    /// printed in the standings. Without the wallet-match guard, anyone could
    /// read one off the crosstable and drive that person's seat.
    #[tokio::test]
    async fn a_signed_in_casual_seat_token_is_not_handed_to_others() {
        let (state, _c, _r) = test_state();
        let tid = tourney_create(
            State(state.clone()),
            HeaderMap::new(),
            Json(TourneyCreateReq {
                name: "Free T".into(),
                buy_in: None,
                initial_secs: 60,
                increment_secs: 1,
                payout: None,
                admission: None,
            }),
        )
        .await
        .expect("create")
        .0
        .tournament_id;
        let wa = "0xaa88888888888888888888888888888888888888";
        let wb = "0xbb99999999999999999999999999999999999999";
        let ta = state.0.auth.mint_session(wa);
        let tb = state.0.auth.mint_session(wb);
        for tok in [&ta, &tb] {
            let _ = tourney_join(
                State(state.clone()),
                Path(tid),
                bearer(tok),
                Json(JoinReq {
                    seat: None,
                    uci_options: None,
                    engine: None,
                    invite: None,
                }),
            )
            .await
            .expect("join");
        }
        let _ = tourney_start(State(state.clone()), Path(tid), HeaderMap::new())
            .await
            .expect("start");

        let ask = |headers: HeaderMap| {
            tourney_my_games(
                State(state.clone()),
                Path(tid),
                Query(MyGamesQuery {
                    // The entrant id is the wallet, exactly as it appears in the
                    // public standings — which is the point.
                    player: Some(wa.to_string()),
                }),
                headers,
            )
        };
        // Anonymous: refused (there is a wallet-bound token to protect).
        assert_eq!(
            ask(HeaderMap::new()).await.err(),
            Some(StatusCode::UNAUTHORIZED)
        );
        // A different signed-in wallet: refused.
        assert_eq!(ask(bearer(&tb)).await.err(), Some(StatusCode::FORBIDDEN));
        // The owner: gets their seat, with a real token.
        let mine = ask(bearer(&ta)).await.expect("own games").0;
        assert_eq!(mine.len(), 1);
        assert_eq!(mine[0].seat, "browser");
        assert!(!mine[0].token.is_empty(), "the owner gets her real token");
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
        assert!(
            matches!(rx_a.try_recv(), Ok(ServerToAgent::AssignSeat { .. })),
            "poster bot seated"
        );
        assert!(
            matches!(rx_b.try_recv(), Ok(ServerToAgent::AssignSeat { .. })),
            "acceptor bot seated"
        );
        assert!(state.0.agents.claim(wa).is_err(), "poster busy");
        assert!(state.0.agents.claim(wb).is_err(), "acceptor busy");
    }
}
