//! Player profiles: aggregate stats + game history for an address (the data
//! behind the chess.com-style profile page).

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::username;
use crate::AppState;

/// Hard ceiling on a stored profile photo. The web client downsizes to a 256px
/// square before uploading, which lands an order of magnitude under this; the
/// cap is what stops a hand-rolled client from parking megabytes per wallet in
/// the database and in every backup of it.
const AVATAR_MAX_BYTES: usize = 256 * 1024;

/// Ceiling on either side of a stored photo, in pixels. Four times what our own
/// client uploads, so a hand-rolled one has room, but far under what it takes to
/// hurt the browsers that later render it (see `sniff_image`).
const AVATAR_MAX_PX: u32 = 1024;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/leaderboard", get(leaderboard))
        // Prefix search for the player typeahead. A STATIC sibling of
        // `/players/{ident}`, which the router prefers — which is exactly why
        // `search` is on `username::RESERVED`: a wallet holding that name would
        // own a URL that resolves to this handler instead of to its profile.
        .route("/players/search", get(search))
        // One route, two identifiers: a 0x address or a username. See
        // `resolve_ident`.
        .route("/players/{ident}", get(profile))
        // Profile photos. Public read, SIWE-authed write — and both live in
        // this router so they inherit its per-IP read throttle (a route added
        // anywhere else is unthrottled). The body limit is belt-and-braces
        // ahead of the handler's own size check, so an oversized upload is
        // rejected before it is buffered.
        .route("/players/{ident}/avatar", get(avatar))
        .route(
            "/profile/avatar",
            post(upload_avatar)
                .delete(delete_avatar)
                .layer(DefaultBodyLimit::max(AVATAR_MAX_BYTES)),
        )
        // Claim or change the signed-in wallet's username. Sits beside the photo
        // write for the same reason: this router carries the throttle. PUT is
        // the honest verb (idempotent, whole-value replacement); POST is
        // accepted so a client that cannot send PUT through a proxy still works.
        .route("/profile/username", put(set_username).post(set_username))
        .route("/players/{ident}/games", get(games))
        // Single-game detail (replay + settlement status). Lives here so it
        // inherits the read rate-limit layer. Axum routes the static
        // `/games/live` (in main.rs) ahead of this dynamic `{id}`.
        .route("/games/{id}", get(game_detail))
        // Lives here (not in matchmaking) so it inherits the read rate-limit
        // layer — it's the one tournament route that hits Postgres.
        .route("/tournaments/claimable/{address}", get(tourney_claimable))
        // Same rationale: DB-backed, so it belongs behind the read throttle.
        .route("/games/unsettled/{address}", get(games_unsettled))
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
    /// Stake in USDC base units (string), None for a free game.
    stake: Option<String>,
    /// Which ladder it counted for — a buy-in tournament game is ranked with
    /// no stake of its own, so this is not `stake.is_some()`.
    rated: bool,
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
    /// Self-declared engines, [white, black]. Unverified by design — display
    /// only, never a basis for anything (ARCHITECTURE.md's trust model).
    white_engine: Option<String>,
    black_engine: Option<String>,
    moves: Vec<MoveView>,
}

/// Full detail for ANY game (pending/active/finished/aborted): metadata + the
/// move list, so the web app can decide live-vs-replay, replay a finished game,
/// and show a wagered game's settlement status. Public — all of it is already
/// public (moves are broadcast to live spectators; wallets appear in
/// `/games/live` and onchain).
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
        rated: g.rated,
        result: g.result,
        reason: g.result_reason,
        result_hash: g.result_hash,
        result_sig: g.result_sig,
        settlement_status: g.settlement_status,
        initial_secs: (g.time_initial_ms / 1000).max(0) as u64,
        increment_secs: (g.time_increment_ms / 1000).max(0) as u64,
        finished_at: g.finished_at.map(|t| t.to_rfc3339()),
        white_engine: g.white_engine,
        black_engine: g.black_engine,
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

#[derive(Serialize)]
struct UnsettledGameView {
    game_id: Uuid,
}

/// Wagered games of this wallet whose escrow we never settled, so the bankroll
/// UI can offer the contract's `claimTimeout` refund instead of leaving the
/// stake recoverable only by a hand-written contract call.
///
/// Candidates only: the chain decides whether the timeout window is actually
/// open and whether someone already claimed, and the UI checks per game.
/// Read-only + best-effort — empty without a DB, like its tournament sibling.
async fn games_unsettled(
    State(state): State<AppState>,
    Path(address): Path<String>,
) -> Json<Vec<UnsettledGameView>> {
    let Some(db) = state.0.db.as_ref() else {
        return Json(Vec::new());
    };
    let rows = db
        .unsettled_wagered_games(&address.to_lowercase())
        .await
        .unwrap_or_default();
    Json(
        rows.into_iter()
            .map(|r| UnsettledGameView { game_id: r.id })
            .collect(),
    )
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
    /// The player's handle, if they have claimed one. The client prefers it over
    /// the address for both the label and the profile link.
    #[serde(skip_serializing_if = "Option::is_none")]
    username: Option<String>,
}

/// Resolve a profile identifier to the wallet it names.
///
/// Address first, and without touching the database: an address is a valid
/// profile identifier whether or not that wallet has ever been seen, which is
/// what keeps a fresh address rendering a default 1500 card. A username is only
/// meaningful if somebody holds it, so an unknown one is a 404.
///
/// One behaviour change rides along: `GET /players/<garbage>` used to return 200
/// with a default card, because nothing checked that the path was an address. It
/// now 404s. The web client always sends an address or a validated username, so
/// only bookmarks and crawlers see the difference.
async fn resolve_ident(db: &persistence::Db, ident: &str) -> Result<String, StatusCode> {
    if username::is_address_shape(ident) {
        return Ok(ident.to_lowercase());
    }
    // The SHAPE gate, not the write gate: a name the server has already issued
    // has to keep resolving even when the word is one nobody new may claim. The
    // house bot is exactly that case — it holds `HouseBot` because the word is
    // reserved to everyone else, and routing through `validate_username` 404'd
    // its own profile while the address still served it.
    if !username::is_username_shape(ident) {
        return Err(StatusCode::NOT_FOUND);
    }
    db.wallet_for_username(ident)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)
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
            username: r.username,
        })
        .collect();
    Ok(Json(entries))
}

/// One ladder's record. Also the shape of the flat fields on `Profile`, which
/// carry the two ladders combined.
#[derive(Serialize)]
struct StatBucket {
    games: i64,
    wins: i64,
    losses: i64,
    draws: i64,
    /// Net winnings in USDC base units (6dp), signed; string to avoid float loss.
    /// Structurally always "0" for casual — free games stake nothing.
    net: String,
}

impl From<persistence::PlayerStatsRow> for StatBucket {
    fn from(s: persistence::PlayerStatsRow) -> Self {
        Self {
            games: s.games,
            wins: s.wins,
            losses: s.losses,
            draws: s.draws,
            net: s.net.to_string(),
        }
    }
}

#[derive(Serialize)]
struct Profile {
    address: String,
    /// Ranked Elo: staked games and buy-in tournaments only. Note this predates
    /// the split, so a wallet that played free games before it carries their
    /// movement here — nothing recorded the per-game deltas, so it can't be
    /// unwound.
    rating: i64,
    /// Casual Elo: every free game. A separate ladder, never mixed in, and
    /// deliberately absent from the leaderboard.
    casual_rating: i64,
    /// Both ladders combined, flattened. Predates the split and keeps its
    /// meaning, so a client that knows nothing about `casual`/`ranked` below
    /// still renders exactly what it used to.
    games: i64,
    wins: i64,
    losses: i64,
    draws: i64,
    net: String,
    /// When this wallet's profile photo last changed (RFC 3339), or null when it
    /// has none. Doubles as the presence flag and as the cache-busting version
    /// the client appends to the image URL — the bytes are never inlined here.
    avatar_updated_at: Option<String>,
    /// This wallet's handle, in the case it was claimed with. Absent for the
    /// large majority of wallets, which never set one — so every client has to
    /// keep its address fallback.
    #[serde(skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    /// The earliest this wallet may change its username again (RFC 3339), or
    /// null when it can change now. Public, and harmless: it says when a name
    /// last moved, nothing more. Carried here so the owner's own profile page
    /// can explain a disabled rename without a second request.
    username_next_change_at: Option<String>,
    /// The same record split by ladder. Their sum is the flat fields above.
    casual: StatBucket,
    ranked: StatBucket,
}

async fn profile(
    State(state): State<AppState>,
    Path(ident): Path<String>,
) -> Result<Json<Profile>, StatusCode> {
    let db = state.0.db.as_ref().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    // The resolved WALLET, never the identifier that was asked for: a client
    // that requested `/players/alice` must get alice's address back, or every
    // link built from this payload (the avatar URL, the games list, a block
    // explorer) points at a string that isn't an address.
    let address = resolve_ident(db, &ident).await?;
    let s = db
        .player_stats(&address)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let card = db
        .player_card(&address)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let all: StatBucket = s.all.into();
    Ok(Json(Profile {
        address: address.to_lowercase(),
        rating: card.rating.round() as i64,
        casual_rating: card.casual_rating.round() as i64,
        games: all.games,
        wins: all.wins,
        losses: all.losses,
        draws: all.draws,
        net: all.net,
        avatar_updated_at: card.avatar_updated_at.map(|t| t.to_rfc3339()),
        username_next_change_at: card.username_next_change_at().map(|t| t.to_rfc3339()),
        username: card.username,
        casual: s.casual.into(),
        ranked: s.ranked.into(),
    }))
}

#[derive(Deserialize)]
struct UsernameReq {
    username: String,
}

/// One prefix-search hit, enough to render a result row without a second fetch.
#[derive(Serialize)]
struct PlayerHit {
    username: String,
    address: String,
    rating: i64,
    avatar_updated_at: Option<String>,
}

#[derive(Deserialize)]
struct SearchQuery {
    /// `default` so a missing `q` is an empty search rather than a 400. Without
    /// it axum's `Query` rejects the request before the handler runs, and the
    /// promise below — that this endpoint answers `[]` instead of erroring —
    /// would be false for the one malformed case a client can send by accident.
    #[serde(default)]
    q: String,
    limit: Option<i64>,
}

/// Prefix search over usernames, for the player typeahead.
///
/// Capped two ways: `limit` is clamped regardless of what was asked, and `q`
/// must itself be a well-formed username prefix. Validating the QUERY, not just
/// the stored names, is what keeps this from becoming a pattern-matching
/// endpoint — without it, `q=%` is a table scan that returns every user on the
/// server.
///
/// Returns `[]` rather than an error for a short, malformed or unanswerable
/// query: a typeahead that 400s mid-keystroke is worse than one that shows
/// nothing. Throttled by this router's per-IP `reads` layer.
async fn search(State(state): State<AppState>, Query(q): Query<SearchQuery>) -> Json<Vec<PlayerHit>> {
    let prefix = q.q.trim();
    let well_formed = (2..=username::USERNAME_MAX).contains(&prefix.chars().count())
        && prefix.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    let Some(db) = state.0.db.as_ref().filter(|_| well_formed) else {
        return Json(Vec::new());
    };
    let hits = db
        .search_usernames(&username::like_prefix(prefix), q.limit.unwrap_or(10).clamp(1, 20))
        .await
        .unwrap_or_default();
    Json(
        hits.into_iter()
            .map(|h| PlayerHit {
                username: h.username,
                address: h.wallet,
                rating: h.rating.round() as i64,
                avatar_updated_at: h.avatar_updated_at.map(|t| t.to_rfc3339()),
            })
            .collect(),
    )
}

/// Claim or change the signed-in wallet's username.
///
/// The wallet comes from the SIWE session, never the body — the same rule the
/// money paths and the photo route follow. There is no address field to forge.
///
/// Returns a body on the failures a client has to tell apart, because status
/// alone cannot: the cooldown is a **403** and not a 429 precisely so it can
/// never be confused with either of this router's two rate limits (the per-IP
/// layer's plain-text 429, and the per-wallet bucket's). Telling a
/// merely-throttled user "you can change again in 7 days" would be wrong and
/// would sound unrecoverable.
///
/// Success is 200 rather than 204 because the response is authoritative about
/// the stored display case — a client that sent `ALICE` while holding `Alice`
/// needs to be told what was actually kept.
async fn set_username(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<UsernameReq>,
) -> Response {
    let wallet = match state.authed_wallet_strict(&headers) {
        Ok(Some(w)) => w,
        Ok(None) => return StatusCode::UNAUTHORIZED.into_response(),
        Err(code) => return code.into_response(),
    };
    // Validate BEFORE charging the bucket. What this meters is write attempts
    // against a unique index, and a name the grammar already rejects never
    // reaches one — so a typo shouldn't spend a token from a budget that refills
    // once every twenty seconds. Rejected requests are still covered by this
    // router's per-IP layer, which is the one sized for junk traffic.
    let name = match username::validate_username(&req.username) {
        Ok(n) => n,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "invalid", "reason": e.code() })),
            )
                .into_response()
        }
    };
    if state.0.limits.username.check(&wallet).is_some() {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({ "error": "rate_limited" })),
        )
            .into_response();
    }
    let Some(db) = state.0.db.as_ref() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    match db.set_username(&wallet, name).await {
        Ok(persistence::SetUsernameOutcome::Set { username }) => {
            (StatusCode::OK, Json(serde_json::json!({ "username": username }))).into_response()
        }
        Ok(persistence::SetUsernameOutcome::Taken) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": "taken" })),
        )
            .into_response(),
        Ok(persistence::SetUsernameOutcome::Cooldown { next_allowed_at }) => (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": "cooldown",
                "next_change_at": next_allowed_at.to_rfc3339(),
            })),
        )
            .into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// What a stored profile photo is allowed to be: its type, and how big it
/// decodes to.
struct ImageInfo {
    mime: &'static str,
    width: u32,
    height: u32,
}

/// Read a profile photo's type and dimensions out of its header.
///
/// The caller's `Content-Type` is ignored on purpose: this route serves the
/// bytes back with the type recorded here, so trusting the uploader's header
/// would let one upload an `image/png` that is really something else and have
/// this server vouch for it. SVG is deliberately unsupported — it is a
/// script-bearing document, and serving one from the API origin would be
/// stored XSS.
///
/// The dimensions matter as much as the type, because a byte cap does not
/// bound a decoded image: a 9000x9000 PNG of one flat colour compresses to
/// ~236 KB, fits the 256 KiB limit with room to spare, and costs every browser
/// that later renders that profile ~0.3 GB — even inside a 72px box, since an
/// `<img>` decodes at full resolution before it scales. Only the uploader's own
/// client keeps photos small; the endpoint has to enforce it.
fn sniff_image(bytes: &[u8]) -> Option<ImageInfo> {
    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    if bytes.starts_with(PNG) {
        // PNG requires IHDR to be the first chunk: a 4-byte length, the tag,
        // then width and height as big-endian u32s.
        if bytes.len() >= 24 && &bytes[12..16] == b"IHDR" {
            return Some(ImageInfo {
                mime: "image/png",
                width: be32(&bytes[16..20]),
                height: be32(&bytes[20..24]),
            });
        }
        return None;
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        let (width, height) = jpeg_dimensions(bytes)?;
        return Some(ImageInfo {
            mime: "image/jpeg",
            width,
            height,
        });
    }
    None
}

fn be32(b: &[u8]) -> u32 {
    u32::from_be_bytes([b[0], b[1], b[2], b[3]])
}

fn be16(b: &[u8]) -> u32 {
    u16::from_be_bytes([b[0], b[1]]) as u32
}

/// Walk a JPEG's segments to its frame header, which is the only place the
/// dimensions live. Returns `None` for anything we can't read confidently —
/// an unreadable header is a rejected upload, not a stored one.
///
/// Walking (rather than scanning for the marker) is what keeps an embedded EXIF
/// thumbnail from answering instead of the real image: its frame header sits
/// inside the APP1 segment we skip over by length.
fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut i = 2; // past the SOI we already matched
    loop {
        // A marker is 0xFF followed by its code; runs of 0xFF are legal fill.
        if *bytes.get(i)? != 0xff {
            return None;
        }
        while *bytes.get(i)? == 0xff {
            i += 1;
        }
        let marker = *bytes.get(i)?;
        i += 1;
        match marker {
            // Standalone markers (TEM, RSTn): no payload to skip.
            0x01 | 0xd0..=0xd7 => {}
            // Start of scan: entropy-coded data follows, so a frame header we
            // haven't reached by now isn't coming. Ditto a second SOI or an EOI.
            0xd8..=0xda => return None,
            // Start of frame, in all its flavours (baseline, progressive,
            // lossless, arithmetic). DHT/JPG/DAC share the 0xC_ range but are
            // not frame headers, hence the three holes.
            0xc0..=0xcf if !matches!(marker, 0xc4 | 0xc8 | 0xcc) => {
                // length(2) precision(1) height(2) width(2)
                let height = be16(bytes.get(i + 3..i + 5)?);
                let width = be16(bytes.get(i + 5..i + 7)?);
                return Some((width, height));
            }
            // Everything else carries a length that includes its own two bytes.
            _ => {
                let len = be16(bytes.get(i..i + 2)?) as usize;
                if len < 2 {
                    return None; // malformed; refuse rather than loop
                }
                i += len;
            }
        }
    }
}

/// A wallet's profile photo. Public, like every other route here: the photo is
/// shown on the public player page, so it is public by construction.
///
/// Served with the sniffed type plus `nosniff`, so the browser can't be talked
/// into interpreting these bytes as anything but the image format we verified.
async fn avatar(
    State(state): State<AppState>,
    Path(ident): Path<String>,
) -> Result<Response, StatusCode> {
    let db = state.0.db.as_ref().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    // Accepts a username too, so a username profile URL doesn't cost the client
    // an extra round trip just to build the image `src`.
    let address = resolve_ident(db, &ident).await?;
    let row = db
        .avatar(&address)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    let mime = axum::http::HeaderValue::from_str(&row.mime)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok((
        [
            (axum::http::header::CONTENT_TYPE, mime),
            // Cacheable because the client fetches through a `?v=<updated_at>`
            // taken from the profile JSON, so a replaced photo is a new URL.
            (
                axum::http::header::CACHE_CONTROL,
                axum::http::HeaderValue::from_static("public, max-age=300"),
            ),
            (
                axum::http::header::X_CONTENT_TYPE_OPTIONS,
                axum::http::HeaderValue::from_static("nosniff"),
            ),
            (
                axum::http::header::CONTENT_DISPOSITION,
                axum::http::HeaderValue::from_static("inline"),
            ),
        ],
        row.data,
    )
        .into_response())
}

/// Set the signed-in wallet's profile photo. The body is the raw image.
///
/// The wallet comes from the SIWE session, never from the request — the same
/// rule the money paths follow, so nobody can set a photo on someone else's
/// profile by naming them.
async fn upload_avatar(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, StatusCode> {
    let wallet = authed_owner(&state, &headers, &state.0.limits.avatar)?;
    let db = state.0.db.as_ref().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    // Belt-and-braces: `DefaultBodyLimit` already rejects an oversized body
    // before it is buffered, so this only fires if that layer is ever removed.
    if body.len() > AVATAR_MAX_BYTES {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let img = sniff_image(&body).ok_or(StatusCode::UNSUPPORTED_MEDIA_TYPE)?;
    if img.width == 0 || img.height == 0 {
        return Err(StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }
    if img.width > AVATAR_MAX_PX || img.height > AVATAR_MAX_PX {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    db.set_avatar(&wallet, img.mime, &body)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::NO_CONTENT)
}

/// Remove the signed-in wallet's profile photo.
async fn delete_avatar(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<StatusCode, StatusCode> {
    let wallet = authed_owner(&state, &headers, &state.0.limits.avatar)?;
    let db = state.0.db.as_ref().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    db.clear_avatar(&wallet)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::NO_CONTENT)
}

/// The wallet whose own profile this request may change, charged against
/// `bucket`.
///
/// Keyed on the wallet rather than the IP because that's what these writes are
/// scoped to — one row — and because the per-IP layer on this router is sized
/// for page reads, not for a stream of row rewrites. Each write takes its own
/// bucket: settling on a profile photo must not eat the budget for picking a
/// name.
fn authed_owner(
    state: &AppState,
    headers: &HeaderMap,
    bucket: &crate::ratelimit::TokenBucket,
) -> Result<String, StatusCode> {
    let wallet = state
        .authed_wallet_strict(headers)?
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if bucket.check(&wallet).is_some() {
        return Err(StatusCode::TOO_MANY_REQUESTS);
    }
    Ok(wallet)
}

#[cfg(test)]
mod tests {
    use super::{sniff_image, AVATAR_MAX_PX};

    /// A PNG header with the given dimensions (nothing past IHDR is read).
    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut v = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        v.extend_from_slice(&13u32.to_be_bytes());
        v.extend_from_slice(b"IHDR");
        v.extend_from_slice(&w.to_be_bytes());
        v.extend_from_slice(&h.to_be_bytes());
        v.extend_from_slice(&[8, 2, 0, 0, 0]);
        v
    }

    /// A JPEG with an APP0 segment before the frame header, like a real one.
    fn jpeg(w: u16, h: u16) -> Vec<u8> {
        let mut v = vec![0xff, 0xd8]; // SOI
        v.extend_from_slice(&[0xff, 0xe0, 0x00, 0x06, b'J', b'F', b'I', b'F']); // APP0
        v.extend_from_slice(&[0xff, 0xc0, 0x00, 0x11, 8]); // SOF0, precision 8
        v.extend_from_slice(&h.to_be_bytes());
        v.extend_from_slice(&w.to_be_bytes());
        v
    }

    fn sniffed(bytes: &[u8]) -> Option<(&'static str, u32, u32)> {
        sniff_image(bytes).map(|i| (i.mime, i.width, i.height))
    }

    #[test]
    fn reads_type_and_size_of_the_formats_we_store() {
        assert_eq!(sniffed(&png(256, 256)), Some(("image/png", 256, 256)));
        assert_eq!(sniffed(&jpeg(640, 480)), Some(("image/jpeg", 640, 480)));
    }

    #[test]
    fn walks_past_segments_to_the_real_frame_header() {
        // An EXIF thumbnail is a whole JPEG nested in APP1. Scanning for the
        // first SOF would find *its* header and report the thumbnail's size,
        // waving the outer image through whatever its real dimensions are.
        let thumb = jpeg(80, 60);
        let mut v = vec![0xff, 0xd8];
        let app1_len = (thumb.len() + 2) as u16;
        v.extend_from_slice(&[0xff, 0xe1]);
        v.extend_from_slice(&app1_len.to_be_bytes());
        v.extend_from_slice(&thumb);
        v.extend_from_slice(&[0xff, 0xc0, 0x00, 0x11, 8]);
        v.extend_from_slice(&4000u16.to_be_bytes());
        v.extend_from_slice(&3000u16.to_be_bytes());
        assert_eq!(sniffed(&v), Some(("image/jpeg", 3000, 4000)));
    }

    #[test]
    fn a_byte_cap_does_not_bound_a_decoded_image() {
        // The whole point of measuring: this header is 24 bytes and describes
        // an image that costs a viewer's browser ~0.3 GB to decode. A real one
        // of these compresses to ~236 KB — comfortably inside AVATAR_MAX_BYTES.
        let bomb = png(9000, 9000);
        let (_, w, h) = sniffed(&bomb).expect("a well-formed header, just an absurd one");
        assert!(
            w > AVATAR_MAX_PX && h > AVATAR_MAX_PX,
            "must be refused by size"
        );
        // One oversized side is enough.
        let (_, w, h) = sniffed(&png(64, 4000)).unwrap();
        assert!(w <= AVATAR_MAX_PX && h > AVATAR_MAX_PX);
    }

    #[test]
    fn rejects_anything_else() {
        // An SVG is the one that matters: it is a script host, and this server
        // hands the stored type back to the browser.
        assert_eq!(sniffed(b"<svg xmlns=\"http://www.w3.org/2000/svg\">"), None);
        assert_eq!(sniffed(b"GIF89a"), None);
        assert_eq!(sniffed(b"\x7fELF"), None);
        assert_eq!(sniffed(b""), None);
        // WebP used to be accepted on the strength of its magic number alone.
        // Nothing reads its dimensions, so it is no longer stored at all.
        assert_eq!(sniffed(b"RIFF\x24\x00\x00\x00WEBPVP8 "), None);
    }

    #[test]
    fn rejects_headers_it_cannot_read() {
        // Truncated magic numbers must not slip through a prefix check.
        assert_eq!(sniffed(&[0xff, 0xd8]), None);
        // Right signature, no IHDR / no room for the dimensions.
        assert_eq!(sniffed(&png(1, 1)[..20]), None);
        let mut no_ihdr = png(8, 8);
        no_ihdr[12..16].copy_from_slice(b"IDAT");
        assert_eq!(sniffed(&no_ihdr), None);
        // A JPEG whose scan starts before any frame header describes nothing.
        assert_eq!(sniffed(&[0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]), None);
        // A zero-length segment would otherwise walk the parser in place.
        assert_eq!(sniffed(&[0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00]), None);
        // Truncated mid-frame-header.
        assert_eq!(sniffed(&jpeg(10, 10)[..14]), None);
    }
}

#[derive(Serialize)]
struct GameItem {
    game_id: String,
    mode: String,
    white: Option<String>,
    black: Option<String>,
    result: Option<String>,
    reason: Option<String>,
    /// Stake in USDC base units (string), null for a free game.
    stake: Option<String>,
    /// Which ladder it counted for. Sent because the client cannot derive it:
    /// a buy-in tournament game is ranked with a null stake, so a viewer that
    /// keys on `stake` alone files it under casual.
    rated: bool,
    moves: i64,
    finished_at: Option<String>,
}

/// Which ladder's games to return. An enum rather than a free string so an
/// unrecognised value 400s in the extractor instead of silently widening to
/// "everything".
#[derive(Deserialize, Default, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
enum GamesFilter {
    #[default]
    All,
    Casual,
    Ranked,
}

impl GamesFilter {
    /// The `rated` predicate this filter maps to; `None` means "don't filter".
    fn rated(self) -> Option<bool> {
        match self {
            GamesFilter::All => None,
            GamesFilter::Casual => Some(false),
            GamesFilter::Ranked => Some(true),
        }
    }
}

#[derive(Deserialize, Default)]
struct GamesQuery {
    #[serde(default)]
    filter: GamesFilter,
}

async fn games(
    State(state): State<AppState>,
    Path(ident): Path<String>,
    Query(q): Query<GamesQuery>,
) -> Result<Json<Vec<GameItem>>, StatusCode> {
    let db = state.0.db.as_ref().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    // Accepts a username, like its sibling routes: `/players/alice/games` 404ing
    // while `/players/alice` works is the kind of asymmetry nobody remembers.
    let address = resolve_ident(db, &ident).await?;
    let rows = db
        // The limit applies AFTER the filter, which is why this isn't done in
        // the browser: 50 of one ladder, not one ladder's share of 50.
        .player_games(&address, 50, q.filter.rated())
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
            rated: r.rated,
            moves: r.moves,
            finished_at: r.finished_at.map(|t| t.to_rfc3339()),
        })
        .collect();
    Ok(Json(items))
}
