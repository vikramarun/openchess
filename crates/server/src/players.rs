//! Player profiles: aggregate stats + game history for an address (the data
//! behind the chess.com-style profile page).

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use uuid::Uuid;

use crate::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/leaderboard", get(leaderboard))
        .route("/players/{address}", get(profile))
        .route("/players/{address}/games", get(games))
        // Single-game detail (replay + settlement status). Lives here so it
        // inherits the read rate-limit layer. Axum routes the static
        // `/games/live` (in main.rs) ahead of this dynamic `{id}`.
        .route("/games/{id}", get(game_detail))
        // Lives here (not in matchmaking) so it inherits the read rate-limit
        // layer — it's the one tournament route that hits Postgres.
        .route("/tournaments/claimable/{address}", get(tourney_claimable))
}

#[derive(Serialize)]
struct MoveView {
    ply: i32,
    uci: String,
    san: String,
    white_ms: i64,
    black_ms: i64,
}

#[derive(Serialize)]
struct GameDetailView {
    game_id: String,
    mode: String,
    status: String,
    white: Option<String>,
    black: Option<String>,
    /// Stake in USDC base units (string), None for casual games.
    stake: Option<String>,
    result: Option<String>,
    reason: Option<String>,
    result_hash: Option<String>,
    /// Oracle signature over `result_hash` (EIP-191 personal_sign), so a replay
    /// can show the same "signed by oracle" verification as the live view.
    result_sig: Option<String>,
    /// none | pending | settled | failed.
    settlement_status: String,
    initial_secs: u64,
    increment_secs: u64,
    finished_at: Option<String>,
    moves: Vec<MoveView>,
}

/// Full detail for ANY game (pending/active/finished/aborted): metadata + the
/// move list, so the web app can decide live-vs-replay, replay a finished game,
/// and show a wagered game's settlement status. Public — all of it is already
/// public (moves are broadcast to live spectators; wallets appear in
/// `/games/live` and on-chain).
async fn game_detail(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<GameDetailView>, StatusCode> {
    let db = state.0.db.as_ref().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let g = db
        .game_detail(id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    let moves = db
        .game_moves(id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(GameDetailView {
        game_id: g.id.to_string(),
        mode: g.mode,
        status: g.status,
        white: g.white_wallet,
        black: g.black_wallet,
        stake: g.stake.map(|d| d.to_string()),
        result: g.result,
        reason: g.result_reason,
        result_hash: g.result_hash,
        result_sig: g.result_sig,
        settlement_status: g.settlement_status,
        initial_secs: (g.time_initial_ms / 1000).max(0) as u64,
        increment_secs: (g.time_increment_ms / 1000).max(0) as u64,
        finished_at: g.finished_at.map(|t| t.to_rfc3339()),
        moves: moves
            .into_iter()
            .map(|m| MoveView {
                ply: m.ply,
                uci: m.uci,
                san: m.san,
                white_ms: m.white_ms,
                black_ms: m.black_ms,
            })
            .collect(),
    }))
}

#[derive(Serialize)]
struct ClaimableView {
    tournament_id: Uuid,
    name: String,
    status: String,
}

/// DB-sourced list of the connected wallet's finished buy-in tournaments, so the
/// bankroll claim UI can surface payouts/refunds even after a restart wipes the
/// in-memory tournaments map. Read-only + best-effort: empty when there's no DB.
async fn tourney_claimable(
    State(state): State<AppState>,
    Path(address): Path<String>,
) -> Json<Vec<ClaimableView>> {
    let Some(db) = state.0.db.as_ref() else {
        return Json(Vec::new());
    };
    let rows = db
        .claimable_tournaments(&address.to_lowercase())
        .await
        .unwrap_or_default();
    Json(
        rows.into_iter()
            .map(|r| ClaimableView {
                tournament_id: r.id,
                name: r.name,
                status: r.status,
            })
            .collect(),
    )
}

#[derive(Serialize)]
struct LeaderboardEntry {
    rank: i64,
    address: String,
    rating: i64,
    games: i64,
}

/// Top-rated players for the lobby board. Rank is 1-based (server-assigned so
/// the client doesn't re-derive it). Empty when there are no rated games yet.
async fn leaderboard(
    State(state): State<AppState>,
) -> Result<Json<Vec<LeaderboardEntry>>, StatusCode> {
    let db = state.0.db.as_ref().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let rows = db
        .leaderboard(100)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let entries = rows
        .into_iter()
        .enumerate()
        .map(|(i, r)| LeaderboardEntry {
            rank: i as i64 + 1,
            address: r.wallet.to_lowercase(),
            rating: r.rating.round() as i64,
            games: r.games,
        })
        .collect();
    Ok(Json(entries))
}

#[derive(Serialize)]
struct Profile {
    address: String,
    rating: i64,
    games: i64,
    wins: i64,
    losses: i64,
    draws: i64,
    /// Net winnings in USDC base units (6dp), signed; string to avoid float loss.
    net: String,
}

async fn profile(
    State(state): State<AppState>,
    Path(address): Path<String>,
) -> Result<Json<Profile>, StatusCode> {
    let db = state.0.db.as_ref().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let s = db
        .player_stats(&address)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let rating = db
        .player_rating(&address)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(Profile {
        address: address.to_lowercase(),
        rating: rating.round() as i64,
        games: s.games,
        wins: s.wins,
        losses: s.losses,
        draws: s.draws,
        net: s.net.to_string(),
    }))
}

#[derive(Serialize)]
struct GameItem {
    game_id: String,
    mode: String,
    white: Option<String>,
    black: Option<String>,
    result: Option<String>,
    reason: Option<String>,
    /// Stake in USDC base units (string), null for casual.
    stake: Option<String>,
    moves: i64,
    finished_at: Option<String>,
}

async fn games(
    State(state): State<AppState>,
    Path(address): Path<String>,
) -> Result<Json<Vec<GameItem>>, StatusCode> {
    let db = state.0.db.as_ref().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let rows = db
        .player_games(&address, 50)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let items = rows
        .into_iter()
        .map(|r| GameItem {
            game_id: r.id.to_string(),
            mode: r.mode,
            white: r.white_wallet,
            black: r.black_wallet,
            result: r.result,
            reason: r.result_reason,
            stake: r.stake.map(|d| d.to_string()),
            moves: r.moves,
            finished_at: r.finished_at.map(|t| t.to_rfc3339()),
        })
        .collect();
    Ok(Json(items))
}
