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
        // Lives here (not in matchmaking) so it inherits the read rate-limit
        // layer — it's the one tournament route that hits Postgres.
        .route("/tournaments/claimable/{address}", get(tourney_claimable))
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
