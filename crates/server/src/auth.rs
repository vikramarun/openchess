//! Sign-In with Ethereum (SIWE / EIP-4361).
//!
//! Flow: the client GETs a `nonce`, builds an EIP-4361 message embedding it,
//! signs it with their wallet, and POSTs `{message, signature}`. We recover the
//! signer from the EIP-191 personal-sign, check the nonce was one we issued,
//! and mint a session token bound to that wallet address.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::AppState;

#[derive(Default)]
pub struct Auth {
    nonces: Mutex<HashSet<String>>,
    /// session token -> wallet address (lowercased 0x...)
    sessions: Mutex<HashMap<String, String>>,
}

impl Auth {
    pub fn wallet_for_token(&self, token: &str) -> Option<String> {
        self.sessions.lock().unwrap().get(token).cloned()
    }
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/auth/nonce", get(nonce))
        .route("/auth/verify", post(verify))
        .route("/auth/me", get(me))
}

#[derive(Serialize)]
struct NonceResp {
    nonce: String,
}

async fn nonce(State(state): State<AppState>) -> Json<NonceResp> {
    let nonce = Uuid::new_v4().simple().to_string();
    state.0.auth.nonces.lock().unwrap().insert(nonce.clone());
    Json(NonceResp { nonce })
}

#[derive(Deserialize)]
struct VerifyReq {
    message: String,
    signature: String,
}

#[derive(Serialize)]
struct VerifyResp {
    token: String,
    address: String,
}

async fn verify(
    State(state): State<AppState>,
    Json(req): Json<VerifyReq>,
) -> Result<Json<VerifyResp>, StatusCode> {
    // The nonce in the message must be one we issued (single-use).
    let nonce = parse_nonce(&req.message).ok_or(StatusCode::BAD_REQUEST)?;
    {
        let mut nonces = state.0.auth.nonces.lock().unwrap();
        if !nonces.remove(nonce) {
            return Err(StatusCode::UNAUTHORIZED);
        }
    }

    // Recover the signer; that address is the authenticated identity.
    let addr = ledger::recover_personal_sign(&req.message, &req.signature)
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let address = format!("{addr:?}").to_lowercase();

    let token = Uuid::new_v4().simple().to_string();
    state
        .0
        .auth
        .sessions
        .lock()
        .unwrap()
        .insert(token.clone(), address.clone());

    Ok(Json(VerifyResp { token, address }))
}

#[derive(Serialize)]
struct MeResp {
    address: String,
}

async fn me(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<MeResp>, StatusCode> {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let address = state
        .0
        .auth
        .wallet_for_token(token)
        .ok_or(StatusCode::UNAUTHORIZED)?;
    Ok(Json(MeResp { address }))
}

/// Extract the `Nonce:` value from an EIP-4361 message.
fn parse_nonce(message: &str) -> Option<&str> {
    message
        .lines()
        .find_map(|l| l.trim().strip_prefix("Nonce:"))
        .map(|n| n.trim())
}
