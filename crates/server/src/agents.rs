//! Agent (bot) registry: one persistent WebSocket per user-run engine.
//!
//! A native BYO client in `connect` mode authenticates with a SIWE session,
//! registers what engine it runs, and then just waits. The web app is the
//! remote control: when its owner starts or joins a game with the bot, the
//! matchmaking layer pushes an `AssignSeat` here instead of handing a launch
//! token back to the browser. One agent per wallet; a reconnect replaces the
//! previous connection.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use protocol::{AgentEnvelope, AgentToServer, Envelope, ServerToAgent, UciOptionInfo};
use serde::Serialize;
use tokio::sync::mpsc;

use crate::{sanitize_label, AppState};

/// Monotonic id distinguishing agent connections, so a stale connection's
/// teardown can't evict its own replacement.
static CONN_SEQ: AtomicU64 = AtomicU64::new(1);

/// A newly-opened control socket must send its `Hello` within this window or
/// it's dropped — bounds slot-holding by connections that never authenticate.
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
/// Keepalive ping cadence for an idle control socket. A connected bot waiting
/// for its owner to start a game is idle by design, so we never time it out on
/// silence; instead we ping, and a failed send reclaims a dead-TCP socket.
const AGENT_PING: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct AgentMeta {
    pub name: String,
    pub engine: String,
    pub options: Vec<UciOptionInfo>,
}

pub struct AgentHandle {
    pub tx: mpsc::Sender<ServerToAgent>,
    pub meta: AgentMeta,
    pub busy: bool,
    conn_id: u64,
}

#[derive(Default)]
pub struct Agents {
    by_wallet: Mutex<HashMap<String, AgentHandle>>,
    /// game id -> agents seated in it (wallet, conn_id at bind time), so the
    /// server can free their busy flags when the room dies — the busy flag is
    /// server-owned; client Status frames are advisory.
    by_game: Mutex<HashMap<protocol::GameId, Vec<(String, u64)>>>,
}

impl Agents {
    /// Register (or replace) the agent for a wallet; returns this connection's id.
    pub fn register(&self, wallet: &str, meta: AgentMeta, tx: mpsc::Sender<ServerToAgent>) -> u64 {
        let conn_id = CONN_SEQ.fetch_add(1, Ordering::Relaxed);
        self.by_wallet.lock().insert(
            wallet.to_lowercase(),
            AgentHandle {
                tx,
                meta,
                busy: false,
                conn_id,
            },
        );
        conn_id
    }

    /// Remove the wallet's agent, but only if it is still this connection —
    /// a reconnect may already have replaced it.
    pub fn remove(&self, wallet: &str, conn_id: u64) {
        let wallet = wallet.to_lowercase();
        let mut agents = self.by_wallet.lock();
        if agents.get(&wallet).map(|a| a.conn_id) == Some(conn_id) {
            agents.remove(&wallet);
        }
    }

    /// Set the busy flag, but only if the wallet's current handle is still the
    /// given connection — a stale connection's buffered frames must not touch
    /// the state of the connection that replaced it.
    pub fn set_busy(&self, wallet: &str, conn_id: u64, busy: bool) {
        if let Some(a) = self.by_wallet.lock().get_mut(&wallet.to_lowercase()) {
            if a.conn_id == conn_id {
                a.busy = busy;
            }
        }
    }

    /// Snapshot for the owner's status endpoint / dispatch checks.
    pub fn view(&self, wallet: &str) -> Option<(AgentMeta, bool)> {
        self.by_wallet
            .lock()
            .get(&wallet.to_lowercase())
            .map(|a| (a.meta.clone(), a.busy))
    }

    /// Claim the wallet's agent for a game: must be online and idle. Marks it
    /// busy and returns its sender in one critical section (no dispatch race).
    pub fn claim(&self, wallet: &str) -> Result<mpsc::Sender<ServerToAgent>, AgentUnavailable> {
        let mut agents = self.by_wallet.lock();
        match agents.get_mut(&wallet.to_lowercase()) {
            None => Err(AgentUnavailable::Offline),
            Some(a) if a.busy => Err(AgentUnavailable::Busy),
            Some(a) => {
                a.busy = true;
                Ok(a.tx.clone())
            }
        }
    }

    /// Release a claim that never turned into a dispatched game (match fell
    /// apart before start). Clears busy regardless of connection.
    pub fn release(&self, wallet: &str) {
        if let Some(a) = self.by_wallet.lock().get_mut(&wallet.to_lowercase()) {
            a.busy = false;
        }
    }

    /// Record that the wallet's agent is seated in this game, so `game_ended`
    /// can free it when the room dies.
    pub fn bind_game(&self, game_id: protocol::GameId, wallet: &str) {
        let wallet = wallet.to_lowercase();
        let conn_id = match self.by_wallet.lock().get(&wallet) {
            Some(a) => a.conn_id,
            None => return, // vanished already; nothing to free later
        };
        self.by_game
            .lock()
            .entry(game_id)
            .or_default()
            .push((wallet, conn_id));
    }

    /// The game's room died (finished, aborted, or reaped): free every agent
    /// that was seated in it. This is the authoritative idle signal — client
    /// Status frames only ever make an agent *less* available, never more.
    pub fn game_ended(&self, game_id: protocol::GameId) {
        let Some(seats) = self.by_game.lock().remove(&game_id) else {
            return;
        };
        for (wallet, conn_id) in seats {
            self.set_busy(&wallet, conn_id, false);
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentUnavailable {
    Offline,
    Busy,
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/agent", get(agent_status))
        .route("/ws/agent", get(ws_agent))
}

#[derive(Serialize)]
struct AgentStatusResp {
    online: bool,
    busy: bool,
    name: Option<String>,
    engine: Option<String>,
    options: Vec<UciOptionInfo>,
}

/// The signed-in user's own bot status (the web app polls this).
async fn agent_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AgentStatusResp>, StatusCode> {
    let wallet = state
        .authed_wallet(&headers)
        .ok_or(StatusCode::UNAUTHORIZED)?;
    Ok(Json(match state.0.agents.view(&wallet) {
        Some((meta, busy)) => AgentStatusResp {
            online: true,
            busy,
            name: Some(meta.name),
            engine: Some(meta.engine),
            options: meta.options,
        },
        None => AgentStatusResp {
            online: false,
            busy: false,
            name: None,
            engine: None,
            options: Vec::new(),
        },
    }))
}

async fn ws_agent(
    State(state): State<AppState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    // Throttle upgrade churn per-IP, then cap concurrent control sockets
    // (global + per-IP) so a flood can't exhaust the node before anyone even
    // authenticates. The slot is held for the socket's whole lifetime.
    let ip = crate::ratelimit::client_ip(&headers);
    if let Some(retry) = state.0.limits.ws.check(&ip) {
        return crate::too_many(retry);
    }
    let Some(guard) = state.0.limits.agent_conns.acquire(&ip) else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };

    // Auth happens on the Hello frame, NOT a URL query parameter: the session
    // token is a 24h wallet-scoped credential (it can move money via staked
    // seats), and query strings end up in proxy/access logs and URI traces.
    let ws = ws.max_message_size(64 * 1024).max_frame_size(64 * 1024);
    ws.on_upgrade(move |socket| async move {
        let _guard = guard; // released when the socket task ends
        handle_agent(state, socket).await;
    })
    .into_response()
}

async fn handle_agent(state: AppState, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();

    // First frame must be Hello (auth + registration). A real client sends it
    // immediately; bound the wait so an un-authenticated socket can't sit here
    // holding a connection slot.
    let hello = tokio::time::timeout(HELLO_TIMEOUT, async {
        loop {
            match stream.next().await {
                Some(Ok(Message::Text(t))) => {
                    let Ok(env) = serde_json::from_str::<AgentEnvelope>(t.as_str()) else {
                        continue;
                    };
                    if let AgentToServer::Hello {
                        token,
                        name,
                        engine,
                        mut options,
                        ..
                    } = env.msg
                    {
                        // The control channel can move money (staked seats), so
                        // it is always wallet-authenticated — no anonymous bots.
                        let Some(wallet) = state.0.auth.wallet_for_token(&token) else {
                            let err = Envelope::new(
                                1,
                                0,
                                ServerToAgent::Error {
                                    code: "unauthorized".into(),
                                    message: "invalid or expired session token".into(),
                                },
                            );
                            if let Ok(text) = serde_json::to_string(&err) {
                                let _ = sink.send(Message::Text(text.into())).await;
                            }
                            return None;
                        };
                        options.truncate(128);
                        let engine = sanitize_label(&engine).unwrap_or_else(|| "engine".into());
                        return Some((
                            wallet,
                            AgentMeta {
                                name: name
                                    .as_deref()
                                    .and_then(sanitize_label)
                                    .unwrap_or_else(|| engine.clone()),
                                engine,
                                options,
                            },
                        ));
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return None,
                _ => continue,
            }
        }
    })
    .await;
    let Ok(Some((wallet, meta))) = hello else {
        // Timed out, closed, or failed auth before registering.
        return;
    };

    let (tx, mut rx) = mpsc::channel::<ServerToAgent>(16);
    let conn_id = state.0.agents.register(&wallet, meta, tx);
    tracing::info!(%wallet, conn_id, "agent registered");

    let hello = Envelope::new(
        1,
        0,
        ServerToAgent::Registered {
            wallet: wallet.clone(),
        },
    );
    if let Ok(text) = serde_json::to_string(&hello) {
        let _ = sink.send(Message::Text(text.into())).await;
    }

    // Writer: registry -> agent, plus a keepalive ping on an idle socket.
    let mut writer = tokio::spawn(async move {
        let mut seq = 1u64;
        let mut ping = tokio::time::interval(AGENT_PING);
        loop {
            tokio::select! {
                msg = rx.recv() => {
                    // Sender dropped (agent replaced by a reconnect, or torn
                    // down): stop writing.
                    let Some(msg) = msg else { break };
                    seq += 1;
                    let env = Envelope::new(seq, 0, msg);
                    let Ok(text) = serde_json::to_string(&env) else { continue };
                    if sink.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                _ = ping.tick() => {
                    // No pong is required — an idle tokio-tungstenite client only
                    // flushes its auto-pong on its next write. The point is that a
                    // failed *send* reveals a dead TCP peer so we reclaim the slot.
                    if sink.send(Message::Ping(Default::default())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    // Reader: status updates until the socket closes OR the writer stops (its
    // keepalive ping hit a dead peer, or a reconnect replaced this agent).
    // Client frames may only make the agent LESS available — the idle
    // transition is server-owned (game_ended via cleanup_task), so a buggy or
    // hostile client can never clear a live claim and trigger double dispatch.
    loop {
        tokio::select! {
            m = stream.next() => {
                let Some(Ok(m)) = m else { break };
                match m {
                    Message::Text(t) => {
                        let Ok(env) = serde_json::from_str::<AgentEnvelope>(t.as_str()) else {
                            continue;
                        };
                        if let AgentToServer::Status { state: s, .. } = env.msg {
                            if s == "playing" {
                                state.0.agents.set_busy(&wallet, conn_id, true);
                            }
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            _ = &mut writer => break,
        }
    }

    state.0.agents.remove(&wallet, conn_id);
    writer.abort();
    tracing::info!(%wallet, conn_id, "agent disconnected");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta() -> AgentMeta {
        AgentMeta {
            name: "bot".into(),
            engine: "sf".into(),
            options: vec![],
        }
    }

    #[test]
    fn claim_marks_busy_and_rejects_double_dispatch() {
        let agents = Agents::default();
        let (tx, _rx) = mpsc::channel(1);
        agents.register("0xAB", meta(), tx);
        assert!(agents.claim("0xab").is_ok()); // case-insensitive
        assert_eq!(agents.claim("0xAB").unwrap_err(), AgentUnavailable::Busy);
        agents.release("0xab");
        assert!(agents.claim("0xab").is_ok());
        assert_eq!(
            agents.claim("0xdead").unwrap_err(),
            AgentUnavailable::Offline
        );
    }

    #[test]
    fn stale_connection_cannot_evict_its_replacement() {
        let agents = Agents::default();
        let (tx, _rx) = mpsc::channel(1);
        let old = agents.register("0xab", meta(), tx.clone());
        let new = agents.register("0xab", meta(), tx);
        agents.remove("0xab", old); // stale teardown — must be a no-op
        assert!(agents.view("0xab").is_some());
        agents.remove("0xab", new);
        assert!(agents.view("0xab").is_none());
    }

    #[test]
    fn stale_connection_cannot_clear_replacements_busy_flag() {
        let agents = Agents::default();
        let (tx, _rx) = mpsc::channel(1);
        let old = agents.register("0xab", meta(), tx.clone());
        let new = agents.register("0xab", meta(), tx);
        assert!(agents.claim("0xab").is_ok()); // new conn claimed for a game
                                               // A buffered frame from the stale connection must not free the claim…
        agents.set_busy("0xab", old, false);
        assert_eq!(agents.claim("0xab").unwrap_err(), AgentUnavailable::Busy);
        // …but the live connection's id can.
        agents.set_busy("0xab", new, false);
        assert!(agents.claim("0xab").is_ok());
    }

    #[test]
    fn game_end_frees_the_seated_agent_server_side() {
        let agents = Agents::default();
        let (tx, _rx) = mpsc::channel(1);
        agents.register("0xab", meta(), tx);
        let game = uuid::Uuid::new_v4();
        assert!(agents.claim("0xab").is_ok());
        agents.bind_game(game, "0xAB");
        assert_eq!(agents.claim("0xab").unwrap_err(), AgentUnavailable::Busy);
        // Room dies (finished/aborted/reaped) → server frees the agent even if
        // the client never reported idle.
        agents.game_ended(game);
        assert!(agents.claim("0xab").is_ok());
        // A second game_ended for the same id is a no-op.
        agents.game_ended(game);
        assert_eq!(agents.claim("0xab").unwrap_err(), AgentUnavailable::Busy);
    }
}
