//! Sign-In with Ethereum (SIWE / EIP-4361).
//!
//! Flow: the client GETs a `nonce`, builds an EIP-4361 message embedding it,
//! signs it, and POSTs `{message, signature}`. We verify: the message's domain
//! and chain id match what we expect, the embedded nonce is one we issued and
//! is still fresh (single-use; expires via sweep), and the recovered signer
//! equals the address stated in the message. Then we mint a TTL'd session token
//! bound to that wallet.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::AppState;

const NONCE_TTL: Duration = Duration::from_secs(300); // 5 min
const SESSION_TTL: Duration = Duration::from_secs(24 * 60 * 60);

fn expected_domain() -> String {
    std::env::var("SIWE_DOMAIN").unwrap_or_else(|_| "localhost:3000".into())
}
fn expected_chain_id() -> String {
    std::env::var("SIWE_CHAIN_ID").unwrap_or_else(|_| "8453".into())
}

#[derive(Default)]
pub struct Auth {
    nonces: Mutex<HashMap<String, Instant>>,
    /// session token -> (wallet address lowercased, issued_at)
    sessions: Mutex<HashMap<String, (String, Instant)>>,
}

impl Auth {
    pub fn wallet_for_token(&self, token: &str) -> Option<String> {
        let sessions = self.sessions.lock().unwrap();
        let (wallet, issued) = sessions.get(token)?;
        if issued.elapsed() > SESSION_TTL {
            return None;
        }
        Some(wallet.clone())
    }

    /// Drop expired nonces and sessions (bounds memory; called periodically).
    pub fn sweep_expired(&self) {
        self.nonces
            .lock()
            .unwrap()
            .retain(|_, t| t.elapsed() < NONCE_TTL);
        self.sessions
            .lock()
            .unwrap()
            .retain(|_, (_, t)| t.elapsed() < SESSION_TTL);
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
    state
        .0
        .auth
        .nonces
        .lock()
        .unwrap()
        .insert(nonce.clone(), Instant::now());
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
    let fields = SiweFields::parse(&req.message).ok_or(StatusCode::BAD_REQUEST)?;

    // Domain + chain binding (EIP-4361's point).
    if fields.domain != expected_domain() || fields.chain_id != expected_chain_id() {
        return Err(StatusCode::UNAUTHORIZED);
    }

    // Nonce must be one we issued and still fresh; consume it (single-use).
    {
        let mut nonces = state.0.auth.nonces.lock().unwrap();
        match nonces.remove(&fields.nonce) {
            Some(issued) if issued.elapsed() < NONCE_TTL => {}
            _ => return Err(StatusCode::UNAUTHORIZED),
        }
    }

    // Recovered signer must match the address the message claims.
    let recovered = ledger::recover_personal_sign(&req.message, &req.signature)
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let recovered = format!("{recovered:?}").to_lowercase();
    if recovered != fields.address.to_lowercase() {
        return Err(StatusCode::UNAUTHORIZED);
    }

    let token = Uuid::new_v4().simple().to_string();
    state
        .0
        .auth
        .sessions
        .lock()
        .unwrap()
        .insert(token.clone(), (recovered.clone(), Instant::now()));

    Ok(Json(VerifyResp {
        token,
        address: recovered,
    }))
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

/// The subset of EIP-4361 fields we verify.
struct SiweFields {
    domain: String,
    address: String,
    chain_id: String,
    nonce: String,
}

impl SiweFields {
    fn parse(message: &str) -> Option<SiweFields> {
        let mut lines = message.lines();
        let first = lines.next()?;
        let domain = first.strip_suffix(" wants you to sign in with your Ethereum account:")?;
        let address = lines.next()?.trim().to_string();
        if !address.starts_with("0x") || address.len() != 42 {
            return None;
        }
        let field = |key: &str| {
            message
                .lines()
                .find_map(|l| l.trim().strip_prefix(key))
                .map(|v| v.trim().to_string())
        };
        Some(SiweFields {
            domain: domain.to_string(),
            address,
            chain_id: field("Chain ID:")?,
            nonce: field("Nonce:")?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_eip4361_fields() {
        let msg = "chess.local wants you to sign in with your Ethereum account:\n\
                   0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC\n\n\
                   Sign in.\n\nURI: http://chess.local\nVersion: 1\n\
                   Chain ID: 8453\nNonce: abc123\nIssued At: 2026-05-30T00:00:00Z";
        let f = SiweFields::parse(msg).expect("parse");
        assert_eq!(f.domain, "chess.local");
        assert_eq!(f.address, "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC");
        assert_eq!(f.chain_id, "8453");
        assert_eq!(f.nonce, "abc123");
    }

    #[test]
    fn rejects_garbage() {
        assert!(SiweFields::parse("not a siwe message").is_none());
    }
}
