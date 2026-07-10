//! WebSocket endpoint: a single connection serves either a player (authed by a
//! launch token bound to a seat) or a read-only spectator.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use protocol::{ClientEnvelope, ClientMessage, Color, Envelope, GameId, ServerMessage};
use serde::Deserialize;
use tokio::sync::{broadcast, mpsc, oneshot};
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

    // Bound message/frame size — clients only ever send small JSON envelopes.
    let ws = ws.max_message_size(16 * 1024).max_frame_size(16 * 1024);
    ws.on_upgrade(move |socket| async move {
        match seat {
            Some(color) => handle_player(state, game_id, color, socket).await,
            None => handle_spectator(state, game_id, socket).await,
        }
    })
}

async fn handle_player(state: AppState, game_id: GameId, color: Color, mut socket: WebSocket) {
    let Some((cmd_tx, _spec)) = state.room_channels(&game_id) else {
        return;
    };

    let (out_tx, mut out_rx) = mpsc::channel::<ServerMessage>(64);
    let (resp_tx, resp_rx) = oneshot::channel();
    if cmd_tx
        .send(RoomCmd::AttachPlayer {
            color,
            out: out_tx.clone(),
            resp: resp_tx,
        })
        .await
        .is_err()
    {
        return;
    }
    // Reject if the seat is already held by a live connection.
    if !matches!(resp_rx.await, Ok(true)) {
        let env = Envelope::new(
            1,
            0,
            ServerMessage::Error {
                code: "seat_occupied".into(),
                message: "this seat already has a live connection".into(),
            },
        );
        if let Ok(text) = serde_json::to_string(&env) {
            let _ = socket.send(Message::Text(text.into())).await;
        }
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
                        // A UCI move is at most 5 chars (e.g. e7e8q); drop
                        // anything longer before it reaches the engine.
                        if uci_move.len() <= 6 {
                            let _ = cmd_tx
                                .send(RoomCmd::Move {
                                    color,
                                    ply,
                                    uci_move,
                                })
                                .await;
                        }
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
    // Connection dropped: free the seat so a reconnect can re-attach.
    let _ = cmd_tx.send(RoomCmd::Detach { color }).await;
    writer.abort();
}

async fn handle_spectator(state: AppState, game_id: GameId, socket: WebSocket) {
    // Subscribe first (so no live move is missed), then snapshot the history.
    let Some((cmd_tx, mut spec_rx)) = state.room_channels(&game_id) else {
        return;
    };
    let snapshot = {
        let (tx, rx) = oneshot::channel();
        if cmd_tx.send(crate::room::RoomCmd::Snapshot { resp: tx }).await.is_ok() {
            rx.await.ok()
        } else {
            None
        }
    };
    let (mut sink, mut stream) = socket.split();

    let writer = tokio::spawn(async move {
        let mut seq = 0u64;
        // Replay the game so far to this spectator: game_start + one
        // opponent_moved per historical move rebuilds the board to the current
        // position (the client applies only legal moves, so any overlap with
        // buffered live messages is harmless). Then stream live updates.
        if let Some(snap) = snapshot {
            if snap.started {
                let mut replay = vec![ServerMessage::GameStart {
                    game_id,
                    start_fen: snap.start_fen,
                    your_color: Color::White,
                    clock: snap.clock,
                }];
                for (i, uci) in snap.moves_uci.into_iter().enumerate() {
                    replay.push(ServerMessage::OpponentMoved {
                        game_id,
                        ply: i as u32,
                        uci,
                        clock: snap.clock,
                    });
                }
                for msg in replay {
                    seq += 1;
                    let env = Envelope::new(seq, 0, msg);
                    if let Ok(text) = serde_json::to_string(&env) {
                        if sink.send(Message::Text(text.into())).await.is_err() {
                            return;
                        }
                    }
                }
            }
        }
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
