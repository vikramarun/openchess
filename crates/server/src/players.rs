//! Player profiles: aggregate stats + game history for an address (the data
//! behind the chess.com-style profile page).

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;

use crate::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/players/{address}", get(profile))
        .route("/players/{address}/games", get(games))
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
