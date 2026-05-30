//! WebSocket endpoint: a single connection serves either a player (authed by a
//! launch token bound to a seat) or a read-only spectator.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use protocol::{ClientEnvelope, ClientMessage, Color, Envelope, GameId, ServerMessage};
use serde::Deserialize;
use tokio::sync::{broadcast, mpsc};
use uuid::Uuid;

use crate::room::RoomCmd;
use crate::AppState;

#[derive(Deserialize)]
pub struct WsQuery {
    token: Option<String>,
}

pub async fn ws_handler(
    State(state): State<AppState>,
    Path(game_id): Path<GameId>,
    Query(q): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    // Resolve role: a valid token bound to this game => player; else spectator.
    let seat = q
        .token
        .as_deref()
        .and_then(|t| state.token_seat(t))
        .filter(|(g, _)| *g == game_id)
        .map(|(_, c)| c);

    ws.on_upgrade(move |socket| async move {
        match seat {
            Some(color) => handle_player(state, game_id, color, socket).await,
            None => handle_spectator(state, game_id, socket).await,
        }
    })
}

async fn handle_player(state: AppState, game_id: GameId, color: Color, socket: WebSocket) {
    let Some((cmd_tx, _spec)) = state.room_channels(&game_id) else {
        return;
    };

    let (out_tx, mut out_rx) = mpsc::channel::<ServerMessage>(64);
    if cmd_tx
        .send(RoomCmd::AttachPlayer {
            color,
            out: out_tx.clone(),
        })
        .await
        .is_err()
    {
        return;
    }

    let (mut sink, mut stream) = socket.split();

    // Writer: room -> client, wrapped in a sequenced envelope.
    let writer = tokio::spawn(async move {
        let mut seq = 0u64;
        while let Some(msg) = out_rx.recv().await {
            seq += 1;
            let env = Envelope::new(seq, 0, msg);
            let Ok(text) = serde_json::to_string(&env) else {
                continue;
            };
            if sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });

    // Reader: client -> room.
    while let Some(Ok(m)) = stream.next().await {
        match m {
            Message::Text(t) => {
                let Ok(env) = serde_json::from_str::<ClientEnvelope>(t.as_str()) else {
                    continue;
                };
                match env.msg {
                    ClientMessage::Hello { .. } => {
                        let _ = out_tx
                            .send(ServerMessage::Welcome {
                                session_id: Uuid::new_v4(),
                                server_time_ms: 0,
                            })
                            .await;
                    }
                    ClientMessage::Ready { .. } => {
                        let _ = cmd_tx.send(RoomCmd::Ready { color }).await;
                    }
                    ClientMessage::Move {
                        ply, uci_move, ..
                    } => {
                        let _ = cmd_tx
                            .send(RoomCmd::Move {
                                color,
                                ply,
                                uci_move,
                            })
                            .await;
                    }
                    ClientMessage::Resign { .. } => {
                        let _ = cmd_tx.send(RoomCmd::Resign { color }).await;
                    }
                    ClientMessage::Heartbeat { .. } | ClientMessage::Resume { .. } => {}
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    writer.abort();
}

async fn handle_spectator(state: AppState, game_id: GameId, socket: WebSocket) {
    let Some((_cmd, mut spec_rx)) = state.room_channels(&game_id) else {
        return;
    };
    let (mut sink, mut stream) = socket.split();

    let writer = tokio::spawn(async move {
        let mut seq = 0u64;
        loop {
            match spec_rx.recv().await {
                Ok(msg) => {
                    seq += 1;
                    let env = Envelope::new(seq, 0, msg);
                    let Ok(text) = serde_json::to_string(&env) else {
                        continue;
                    };
                    if sink.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    // Drain (and ignore) inbound until the socket closes.
    while let Some(Ok(m)) = stream.next().await {
        if matches!(m, Message::Close(_)) {
            break;
        }
    }
    writer.abort();
}
