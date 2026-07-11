//! Networked play: connect to the game server over WebSocket, authenticate
//! with a launch token, and relay between the server (the authority) and the
//! local UCI engine.

use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use protocol::{ClientCapabilities, ClientMessage, Color, Envelope, ServerEnvelope, ServerMessage};
use shakmaty::uci::UciMove;
use shakmaty::{Chess, Position};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use crate::book::OpeningBook;
use crate::engine::UciEngine;

pub struct PlayOpts {
    pub server: String,
    pub game_id: String,
    pub token: String,
    pub engine_path: String,
    pub engine_args: Vec<String>,
    /// Shared read-only book — real books are large, so open once and share
    /// across games instead of re-reading/re-sorting per game.
    pub book: Option<std::sync::Arc<OpeningBook>>,
    /// UCI options applied after launch (e.g. Threads, Hash, Skill Level).
    pub uci_options: Vec<(String, String)>,
}

/// Rebuild a position from the UCI move history (for book probing).
fn position_from(moves_uci: &[String]) -> Option<Chess> {
    let mut pos = Chess::default();
    for u in moves_uci {
        let m = u.parse::<UciMove>().ok()?.to_move(&pos).ok()?;
        pos = pos.play(&m).ok()?;
    }
    Some(pos)
}

pub async fn play(opts: PlayOpts) -> Result<()> {
    let url = format!(
        "{}/ws/game/{}?token={}",
        opts.server.trim_end_matches('/'),
        opts.game_id,
        opts.token
    );
    println!("Connecting to {url}");
    let (ws, _resp) = connect_async(&url).await?;
    let (mut write, mut read) = ws.split();

    let mut engine = UciEngine::launch(&opts.engine_path, &opts.engine_args).await?;
    engine.set_option("MultiPV", "1").await?;
    for (k, v) in &opts.uci_options {
        engine.set_option(k, v).await?;
    }
    println!("Engine: {}", engine.name);

    let mut seq = 0u64;
    let mut my_color: Option<Color> = None;

    // Authenticate.
    send(
        &mut write,
        &mut seq,
        ClientMessage::Hello {
            token: opts.token.clone(),
            client_version: env!("CARGO_PKG_VERSION").to_string(),
            capabilities: ClientCapabilities::default(),
        },
    )
    .await?;

    while let Some(frame) = read.next().await {
        let frame = frame?;
        let text = match frame {
            Message::Text(t) => t.to_string(),
            Message::Close(_) => break,
            _ => continue,
        };
        let env: ServerEnvelope = match serde_json::from_str(&text) {
            Ok(e) => e,
            Err(_) => continue,
        };

        match env.msg {
            ServerMessage::Welcome { .. } => {
                engine.new_game().await?;
                send(
                    &mut write,
                    &mut seq,
                    ClientMessage::Ready {
                        game_id: parse_id(&opts.game_id)?,
                    },
                )
                .await?;
                println!("Ready, waiting for game start...");
            }
            ServerMessage::GameStart {
                your_color,
                opponent,
                ..
            } => {
                my_color = Some(your_color);
                match &opponent {
                    Some(o) => println!(
                        "Game started. I am {your_color:?}, facing {}{}.",
                        o.name,
                        o.declared_engine
                            .as_deref()
                            .map(|e| format!(" ({e})"))
                            .unwrap_or_default()
                    ),
                    None => println!("Game started. I am {your_color:?}."),
                }
            }
            ServerMessage::YourTurn {
                game_id,
                ply,
                moves_uci,
                clock,
                ..
            } => {
                let inc = clock.increment_ms;
                // Try the opening book first; fall back to the engine.
                let book_move = opts.book.as_ref().and_then(|b| {
                    position_from(&moves_uci).and_then(|pos| b.pick(&pos, moves_uci.len() as u32))
                });
                let uci_move = match book_move {
                    Some(m) => {
                        println!("ply {ply}: book move {m}");
                        m
                    }
                    None => {
                        engine
                            .best_move_with_clock(
                                &moves_uci,
                                clock.white_ms,
                                clock.black_ms,
                                inc,
                                inc,
                            )
                            .await?
                    }
                };
                let my_clock = match my_color {
                    Some(Color::White) => clock.white_ms,
                    Some(Color::Black) => clock.black_ms,
                    None => 0,
                };
                println!("ply {ply}: playing {uci_move}");
                send(
                    &mut write,
                    &mut seq,
                    ClientMessage::Move {
                        game_id,
                        ply,
                        uci_move,
                        client_clock_ms: my_clock,
                        sig: None,
                    },
                )
                .await?;
            }
            ServerMessage::MoveAccepted { .. } => {}
            ServerMessage::OpponentMoved { uci, .. } => {
                println!("opponent played {uci}");
            }
            ServerMessage::MoveRejected { reason, .. } => {
                eprintln!("move rejected: {reason}");
            }
            ServerMessage::GameOver {
                result, final_pgn, ..
            } => {
                println!("\nGame over: {:?}", result);
                println!("PGN: {final_pgn}");
                break;
            }
            ServerMessage::Error { code, message } => {
                return Err(anyhow!("server error [{code}]: {message}"));
            }
            _ => {}
        }
    }

    engine.quit().await?;
    Ok(())
}

async fn send<S>(write: &mut S, seq: &mut u64, msg: ClientMessage) -> Result<()>
where
    S: SinkExt<Message> + Unpin,
    <S as futures_util::Sink<Message>>::Error: std::error::Error + Send + Sync + 'static,
{
    *seq += 1;
    let env = Envelope::new(*seq, 0, msg);
    let text = serde_json::to_string(&env)?;
    write.send(Message::Text(text.into())).await?;
    Ok(())
}

fn parse_id(s: &str) -> Result<protocol::GameId> {
    s.parse().map_err(|_| anyhow!("invalid game id: {s}"))
}
