//! Sign-In with Ethereum (SIWE / EIP-4361).
//!
//! Flow: the client GETs a `nonce`, builds an EIP-4361 message embedding it,
//! signs it, and POSTs `{message, signature}`. We verify: the message's domain
//! and chain id match what we expect, the embedded nonce is one we issued and
//! is still fresh (single-use; expires via sweep), and the recovered signer
//! equals the address stated in the message. Then we mint a TTL'd session token
//! bound to that wallet.
//!
//! A session reaches us one of two ways, and `presented_session` is the only
//! place that reads either:
//!
//! - `Authorization: Bearer <token>` — the native `chess-client` and the house
//!   bot. The token travels in the response body and the caller keeps it.
//! - The `__Host-openchess_session` cookie — the web app. httpOnly, so script on
//!   the page (an XSS) can never read it, which is the whole point: a session
//!   commits its wallet's escrow balance to staked games, so a stolen token used
//!   to be stealable money. The web app is the ONLY cookie client, and the
//!   cookie only counts when the request also carries `X-OpenChess-Session` and
//!   comes from `WEB_ORIGIN` (see `presented_session` for why both).
//!
//! The cookie is SameSite=Strict and host-only, so it needs the API on the same
//! SITE as the web app (`api.openchess.ai` beside `openchess.ai`); from
//! `openchess.fly.dev` it would be a third-party cookie that Safari drops.
//! SECURITY.md records the design and the alternatives it beat.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::AppState;

const NONCE_TTL: Duration = Duration::from_secs(300); // 5 min
const SESSION_TTL: Duration = Duration::from_secs(24 * 60 * 60);
/// Link codes pair a native BYO-engine client with a browser session; they are
/// short-lived and single-use because claiming one mints a session for the
/// issuing wallet.
const LINK_CODE_TTL: Duration = Duration::from_secs(10 * 60);

pub(crate) fn expected_domain() -> String {
    std::env::var("SIWE_DOMAIN").unwrap_or_else(|_| "localhost:3000".into())
}
fn expected_chain_id() -> String {
    std::env::var("SIWE_CHAIN_ID").unwrap_or_else(|_| "8453".into())
}

/// The web app's full origin. It is both the CORS allow-origin (`main.rs`) and
/// the only `Origin` a session cookie is honoured from.
pub(crate) fn web_origin() -> String {
    std::env::var("WEB_ORIGIN").unwrap_or_else(|_| "http://localhost:3000".into())
}

/// The web session cookie. `__Host-` makes the browser refuse it unless it is
/// Secure, `Path=/` and has no `Domain` — so it is pinned to the API host and no
/// sibling subdomain can set or shadow it.
pub(crate) const SESSION_COOKIE: &str = "__Host-openchess_session";

/// Sent by the web app on every request it means to be signed in. Two jobs:
///
/// - **CSRF.** A custom header can't be set by a cross-site form or `<img>`,
///   and on a cross-origin `fetch` it forces a CORS preflight that only
///   `WEB_ORIGIN` passes. A cookie without it is ignored.
/// - **"I am presenting a credential."** The browser can't read the httpOnly
///   cookie, and it may have dropped it (expiry, cleared site data). Without a
///   way to say "I meant to be signed in", a missing cookie would downgrade the
///   caller to anonymous — the exact footgun `authed_wallet_strict` exists to
///   refuse. With it, header-but-no-valid-cookie is a 401, like a stale bearer.
pub(crate) const SESSION_HEADER: &str = "x-openchess-session";

/// What credential a request offered.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Presented {
    /// Nothing: a genuinely anonymous caller.
    None,
    /// A session token to look up (from the bearer or the cookie).
    Token(String),
    /// Something was offered and it can't be a session: a malformed
    /// `Authorization`, or the session header with no cookie / the wrong
    /// `Origin`. Strict callers 401 on it.
    Invalid,
}

/// The single reader of a request's session credential.
///
/// The bearer wins when present: it is explicit, and it is how the native
/// client (which never has the cookie) authenticates. Otherwise the cookie
/// counts only alongside `SESSION_HEADER` and an `Origin` equal to
/// `WEB_ORIGIN`. The `Origin` check is belt-and-braces over the preflight the
/// header already forces: it keeps the cookie bound to the web app even if the
/// CORS layer is ever loosened. A browser always sends `Origin` here, because
/// the web app and the API are different origins.
pub(crate) fn presented_session(headers: &HeaderMap) -> Presented {
    if let Some(value) = headers.get(header::AUTHORIZATION) {
        return match value.to_str().ok().and_then(|v| v.strip_prefix("Bearer ")) {
            Some(token) => Presented::Token(token.to_string()),
            None => Presented::Invalid,
        };
    }
    if !headers.contains_key(SESSION_HEADER) {
        // A cookie on its own authenticates nothing (see SESSION_HEADER).
        return Presented::None;
    }
    let origin_ok = headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|o| o == web_origin());
    if !origin_ok {
        return Presented::Invalid;
    }
    match session_cookie(headers) {
        Some(token) => Presented::Token(token),
        None => Presented::Invalid,
    }
}

/// The session cookie's value, across every `Cookie` header (HTTP/2 may split
/// them).
fn session_cookie(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, _)| *name == SESSION_COOKIE)
        .map(|(_, value)| value.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// `Set-Cookie` for a web session. Max-Age matches the server TTL; the server
/// is still the authority (a restart voids every session long before that).
fn session_set_cookie(token: &str) -> HeaderValue {
    HeaderValue::from_str(&format!(
        "{SESSION_COOKIE}={token}; Path=/; Max-Age={}; Secure; HttpOnly; SameSite=Strict",
        SESSION_TTL.as_secs()
    ))
    // A token is 32 hex chars, so this can't fail; never panic on a sign-in.
    .unwrap_or_else(|_| HeaderValue::from_static(""))
}

#[derive(Default)]
pub struct Auth {
    nonces: Mutex<HashMap<String, Instant>>,
    /// session token -> (wallet address lowercased, issued_at)
    sessions: Mutex<HashMap<String, (String, Instant)>>,
    /// link code -> (wallet address lowercased, issued_at). Single-use.
    link_codes: Mutex<HashMap<String, (String, Instant)>>,
}

impl Auth {
    /// End a session (sign-out). Unknown tokens are a no-op.
    pub fn revoke(&self, token: &str) {
        self.sessions.lock().remove(token);
    }

    pub fn wallet_for_token(&self, token: &str) -> Option<String> {
        let sessions = self.sessions.lock();
        let (wallet, issued) = sessions.get(token)?;
        if issued.elapsed() > SESSION_TTL {
            return None;
        }
        Some(wallet.clone())
    }

    /// Mint a fresh session token bound to a wallet (lowercased).
    pub fn mint_session(&self, wallet: &str) -> String {
        let token = Uuid::new_v4().simple().to_string();
        self.sessions
            .lock()
            .insert(token.clone(), (wallet.to_lowercase(), Instant::now()));
        token
    }

    /// Mint a single-use link code an already-authenticated user can hand to a
    /// native client, which claims it for its own session token.
    pub fn mint_link_code(&self, wallet: &str) -> String {
        let code = Uuid::new_v4().simple().to_string();
        self.link_codes
            .lock()
            .insert(code.clone(), (wallet.to_lowercase(), Instant::now()));
        code
    }

    /// Claim (and consume) a link code, returning the bound wallet if the code
    /// exists and is still fresh.
    pub fn claim_link_code(&self, code: &str) -> Option<String> {
        let (wallet, issued) = self.link_codes.lock().remove(code)?;
        if issued.elapsed() > LINK_CODE_TTL {
            return None;
        }
        Some(wallet)
    }

    /// Drop expired nonces, sessions and link codes (bounds memory).
    pub fn sweep_expired(&self) {
        self.nonces.lock().retain(|_, t| t.elapsed() < NONCE_TTL);
        self.sessions
            .lock()
            .retain(|_, (_, t)| t.elapsed() < SESSION_TTL);
        self.link_codes
            .lock()
            .retain(|_, (_, t)| t.elapsed() < LINK_CODE_TTL);
    }
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/auth/nonce", get(nonce))
        .route("/auth/verify", post(verify))
        .route("/auth/me", get(me))
        .route("/auth/cookie", post(adopt_cookie))
        .route("/auth/logout", post(logout))
        .route("/auth/link", post(link))
        .route("/auth/link/claim", post(link_claim))
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
        .insert(nonce.clone(), Instant::now());
    Json(NonceResp { nonce })
}

#[derive(Deserialize)]
struct VerifyReq {
    message: String,
    signature: String,
    /// The web app asks for its session as an httpOnly cookie instead of a
    /// token in the body. The native client omits it and keeps the bearer.
    #[serde(default)]
    cookie: bool,
}

#[derive(Serialize)]
struct VerifyResp {
    /// Absent when the session went into the cookie: a token in the body is one
    /// a script on the page could read, which is what the cookie is avoiding.
    #[serde(skip_serializing_if = "Option::is_none")]
    token: Option<String>,
    address: String,
}

async fn verify(
    State(state): State<AppState>,
    Json(req): Json<VerifyReq>,
) -> Result<Response, StatusCode> {
    let fields = SiweFields::parse(&req.message).ok_or(StatusCode::BAD_REQUEST)?;

    // Fail closed on misconfig: a real (onchain) deployment must set SIWE_DOMAIN
    // explicitly. Otherwise `expected_domain()` falls back to `localhost:3000`,
    // and a signature a user was tricked into producing for `localhost:3000`
    // would authenticate against the production node.
    if state.0.settlement.is_onchain() && std::env::var("SIWE_DOMAIN").is_err() {
        tracing::error!("SIWE_DOMAIN unset on an onchain deployment — refusing sign-in");
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }

    // Domain + chain binding (EIP-4361's point).
    if fields.domain != expected_domain() || fields.chain_id != expected_chain_id() {
        return Err(StatusCode::UNAUTHORIZED);
    }

    // Nonce must be one we issued and still fresh; consume it (single-use).
    {
        let mut nonces = state.0.auth.nonces.lock();
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

    let token = state.0.auth.mint_session(&recovered);
    Ok(session_response(token, recovered, req.cookie))
}

/// A freshly minted session, as a cookie (web) or a body token (native).
fn session_response(token: String, address: String, cookie: bool) -> Response {
    if cookie {
        (
            [(header::SET_COOKIE, session_set_cookie(&token))],
            Json(VerifyResp {
                token: None,
                address,
            }),
        )
            .into_response()
    } else {
        Json(VerifyResp {
            token: Some(token),
            address,
        })
        .into_response()
    }
}

/// Move a bearer session into the cookie: `POST` with `Authorization: Bearer`.
///
/// For one migration only. Web sessions used to live in `localStorage`, and a
/// returning visitor still holding one must not be signed out by the deploy
/// that stops storing it — so the web app trades it here once and deletes its
/// copy. The same token is reused rather than rotated: a lost response then
/// leaves the client's retry working instead of 401ing it out of a live
/// session. Bearer-only on purpose; there is nothing to adopt from a cookie.
async fn adopt_cookie(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(StatusCode::UNAUTHORIZED)?
        .to_string();
    let address = state
        .0
        .auth
        .wallet_for_token(&token)
        .ok_or(StatusCode::UNAUTHORIZED)?;
    Ok(session_response(token, address, true))
}

/// End the presented session (cookie or bearer). Always 204: signing out of a
/// session that already died is not an error.
///
/// Deliberately sends no clearing `Set-Cookie`. The web app fires this
/// without waiting and may sign straight back in (an account switch), so a
/// clearing header landing after the new sign-in's response would delete the
/// NEW cookie. The dead cookie left behind is inert: revoked here, and the web
/// app stops sending it (and the session header) the moment it signs out.
async fn logout(State(state): State<AppState>, headers: HeaderMap) -> StatusCode {
    if let Presented::Token(token) = presented_session(&headers) {
        state.0.auth.revoke(&token);
    }
    StatusCode::NO_CONTENT
}

#[derive(Serialize)]
struct LinkResp {
    code: String,
    expires_secs: u64,
}

/// Mint a single-use link code for the authenticated wallet. A native BYO
/// client claims it (below) to get its own session token — so wagered play
/// from the CLI never needs a private key or a copy-pasted session token.
async fn link(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<LinkResp>, StatusCode> {
    let wallet = state
        .authed_wallet(&headers)
        .ok_or(StatusCode::UNAUTHORIZED)?;
    Ok(Json(LinkResp {
        code: state.0.auth.mint_link_code(&wallet),
        expires_secs: LINK_CODE_TTL.as_secs(),
    }))
}

#[derive(Deserialize)]
struct LinkClaimReq {
    code: String,
}

/// Exchange a fresh link code for a session token (consumes the code).
async fn link_claim(
    State(state): State<AppState>,
    Json(req): Json<LinkClaimReq>,
) -> Result<Json<VerifyResp>, StatusCode> {
    let wallet = state
        .0
        .auth
        .claim_link_code(&req.code)
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let token = state.0.auth.mint_session(&wallet);
    Ok(Json(VerifyResp {
        token: Some(token),
        address: wallet,
    }))
}

#[derive(Serialize)]
struct MeResp {
    address: String,
}

/// The wallet the presented session belongs to. The web app calls it right
/// after sign-in to prove the cookie actually stuck (it can't read the cookie).
async fn me(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<MeResp>, StatusCode> {
    let address = state
        .authed_wallet(&headers)
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
        // Per EIP-4361 the labelled fields live in the structured block that
        // starts at the `URI:` line. Anchor parsing there so a free-form
        // statement line can't shadow `Nonce:`/`Chain ID:`.
        let block_start = message
            .lines()
            .position(|l| l.trim_start().starts_with("URI:"))
            .unwrap_or(0);
        let field = |key: &str| {
            message
                .lines()
                .skip(block_start)
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

    #[test]
    fn link_code_is_single_use_and_bound_to_wallet() {
        let auth = Auth::default();
        let code = auth.mint_link_code("0xABCDEF0000000000000000000000000000000001");
        // Claims once, lowercased…
        assert_eq!(
            auth.claim_link_code(&code).as_deref(),
            Some("0xabcdef0000000000000000000000000000000001")
        );
        // …and never again.
        assert!(auth.claim_link_code(&code).is_none());
        // Unknown codes fail.
        assert!(auth.claim_link_code("nope").is_none());
    }

    #[test]
    fn minted_session_resolves_wallet() {
        let auth = Auth::default();
        let token = auth.mint_session("0xAA00000000000000000000000000000000000002");
        assert_eq!(
            auth.wallet_for_token(&token).as_deref(),
            Some("0xaa00000000000000000000000000000000000002")
        );
    }
}
