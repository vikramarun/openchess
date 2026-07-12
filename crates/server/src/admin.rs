//! Owner-only server administration.
//!
//! Currently just the maintenance/drain switch: the escrow owner (proven via a
//! SIWE session whose wallet matches the on-chain `owner()`) flips it from the
//! web app. When on, `AppState::start_game` refuses new games while in-flight
//! games play out — a manual "drain before deploy" / emergency stop, mirroring
//! chess.com's maintenance mode. The flag is persisted (`server_settings`) so it
//! survives the restart it was set to protect.

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::AppState;

/// `server_settings` key for the persisted maintenance flag.
pub const MAINTENANCE_KEY: &str = "maintenance";

pub fn routes() -> Router<AppState> {
    Router::new().route("/admin/maintenance", post(set_maintenance))
}

#[derive(Deserialize)]
struct MaintenanceReq {
    on: bool,
}

#[derive(Serialize)]
struct MaintenanceResp {
    maintenance: bool,
}

/// Toggle maintenance/drain mode. Owner-only: rejects anything but a SIWE
/// session bound to the escrow owner wallet. The authorization comes from the
/// session, never the request body (money-adjacent — same rule as seats).
async fn set_maintenance(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<MaintenanceReq>,
) -> Result<Json<MaintenanceResp>, StatusCode> {
    if !state.is_admin(&headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    let maintenance = state.set_maintenance(req.on).await;
    Ok(Json(MaintenanceResp { maintenance }))
}
