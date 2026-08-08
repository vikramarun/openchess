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
    /// How much of the clock the engine may spend on one move.
    pub time: TimePolicy,
}

/// Per-move time budgeting, on top of whatever the engine decides for itself.
///
/// The server charges wall-clock from the moment it sends `your_turn` to the
/// moment the move lands, so an engine that budgets purely from `wtime` is
/// spending time it doesn't have — every round trip and every scheduler hiccup
/// comes out of its clock unmodelled.
#[derive(Clone, Copy, Debug)]
pub struct TimePolicy {
    /// Reserved per move for the round trip to the server. Stockfish's own
    /// default (`Move Overhead` = 10ms) assumes a local opponent; over a real
    /// network that shortfall accumulates into a flag.
    pub move_overhead_ms: u64,
    /// Hard ceiling on a single search, or `None` to let the engine decide.
    ///
    /// Worth setting for any long-running bot: Stockfish 17 will spend ~62s on
    /// move 1 of a 10+0 game (and ~5s on move 1 of 3+0) because sudden-death
    /// allocation lets one unstable root eat up to 7x the target. It then plays
    /// the rest of the game in a hurry.
    pub max_move_ms: Option<u64>,
}

impl Default for TimePolicy {
    fn default() -> Self {
        TimePolicy {
            move_overhead_ms: DEFAULT_MOVE_OVERHEAD_MS,
            max_move_ms: None,
        }
    }
}

/// Default reserve per move for the network round trip, in ms.
pub const DEFAULT_MOVE_OVERHEAD_MS: u64 = 250;

/// The `movetime` ceiling to attach to a `go`, given the policy and how much
/// clock this side actually has left. `None` means "no ceiling".
///
/// The cap is also floored so a bot in deep time trouble is never told to
/// search for ~0ms: the engine's own manager already handles that case, and
/// forcing a 1ms search would throw the game away rather than lose on time.
fn move_cap_ms(policy: &TimePolicy, remaining_ms: u64) -> Option<u64> {
    const FLOOR_MS: u64 = 50;
    let max = policy.max_move_ms?;
    let usable = remaining_ms.saturating_sub(policy.move_overhead_ms);
    Some(max.min(usable).max(FLOOR_MS))
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
    // Before the caller's options, so an explicit `--uci-option "Move
    // Overhead=..."` still wins.
    if engine.supports_option("Move Overhead") {
        engine
            .set_option("Move Overhead", &opts.time.move_overhead_ms.to_string())
            .await?;
    }
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
                let my_clock = match my_color {
                    Some(Color::White) => clock.white_ms,
                    Some(Color::Black) => clock.black_ms,
                    None => 0,
                };
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
                                move_cap_ms(&opts.time, my_clock),
                            )
                            .await?
                    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn capped(max_move_ms: u64) -> TimePolicy {
        TimePolicy {
            max_move_ms: Some(max_move_ms),
            ..TimePolicy::default()
        }
    }

    #[test]
    fn no_cap_unless_one_was_asked_for() {
        // The default must not change how anyone's existing engine plays —
        // only the opt-in ceiling does.
        assert_eq!(move_cap_ms(&TimePolicy::default(), 180_000), None);
    }

    #[test]
    fn caps_the_opening_search() {
        // The case this exists for: Stockfish would otherwise spend ~62s on
        // move 1 of a 10+0 game.
        assert_eq!(move_cap_ms(&capped(7_500), 600_000), Some(7_500));
    }

    #[test]
    fn never_budgets_time_the_clock_does_not_have() {
        // 2s left, 250ms of it owed to the network: search at most 1.75s, not
        // the 5s ceiling.
        assert_eq!(move_cap_ms(&capped(5_000), 2_000), Some(1_750));
    }

    #[test]
    fn keeps_a_floor_when_the_clock_is_nearly_gone() {
        // Below the overhead the subtraction saturates to zero. Telling the
        // engine to search for ~0ms throws the game away; losing on time was
        // already the likely outcome, so leave it a usable sliver and let the
        // engine's own manager decide.
        assert_eq!(move_cap_ms(&capped(5_000), 100), Some(50));
        assert_eq!(move_cap_ms(&capped(5_000), 0), Some(50));
    }
}
