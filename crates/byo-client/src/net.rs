//! Networked play: connect to the game server over WebSocket, authenticate
//! with a launch token, and relay between the server (the authority) and the
//! local UCI engine.

use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use protocol::{
    ClientCapabilities, ClientMessage, Clock, Color, Envelope, ServerEnvelope, ServerMessage,
    TimeControl,
};
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
/// Both fields default to `None`, which reads as "decide this per game" rather
/// than "off": the reserve is scaled to the time control and the ceiling is
/// left to the engine.
#[derive(Clone, Copy, Debug, Default)]
pub struct TimePolicy {
    /// Reserved per move for the round trip to the server. Stockfish's own
    /// default (`Move Overhead` = 10ms) assumes a local opponent; over a real
    /// network that shortfall accumulates into a flag.
    ///
    /// `None` — the default — scales it to the game's time control once
    /// `GameStart` reveals the clock (see `move_overhead_for`). `Some` pins it,
    /// for an operator who knows their own latency.
    pub move_overhead_ms: Option<u64>,
    /// Floor on a single search once the clock is too low for the engine's own
    /// manager to be worth delegating to, or `None` to always delegate.
    ///
    /// The mirror of `max_move_ms`, and it has to work differently. A ceiling
    /// rides along on the normal clock-based `go`; a floor cannot, because a
    /// `movetime` next to a `wtime` is only ever a ceiling — verified, `go
    /// wtime 10000 btime 10000 movetime 1000` still spends 2ms. Raising a floor
    /// means REPLACING the command with a bare `go movetime`, which is a
    /// takeover: below the threshold this client budgets the move itself and
    /// the engine's manager is not consulted.
    ///
    /// Off by default on purpose. A connected engine's time manager is its
    /// author's business, and the threshold below assumes Stockfish-style
    /// sudden-death allocation — true of the house bot and of most BYO setups,
    /// but not something to impose on an engine we know nothing about.
    pub min_move_ms: Option<u64>,
    /// Hard ceiling on a single search, or `None` to let the engine decide.
    ///
    /// Worth setting for any long-running bot: Stockfish 17 will spend ~62s on
    /// move 1 of a 10+0 game (and ~5s on move 1 of 3+0) because sudden-death
    /// allocation lets one unstable root eat up to 7x the target. It then plays
    /// the rest of the game in a hurry.
    pub max_move_ms: Option<u64>,
}

/// Bounds on the per-move network reserve, in ms.
pub const MIN_MOVE_OVERHEAD_MS: u64 = 50;
pub const MAX_MOVE_OVERHEAD_MS: u64 = 250;

/// The reserve to use for a game whose clock starts at `initial_ms`.
///
/// A flat reserve is not a flat cost. Stockfish's sudden-death manager takes
/// `Move Overhead × (2 + movestogo)` off the clock BEFORE allocating anything,
/// and with no `movestogo` it assumes 50 — so a 250ms reserve holds back 13
/// SECONDS. That is 2% of a 10+0 clock and 22% of a 1+0 one, which is why a
/// bullet seat fell off a cliff a rapid seat never reached: under 13s of clock
/// there was nothing left to allocate and the engine answered in ~2ms. Measured
/// on the same search at 15s left: 100ms of thinking at a 250ms reserve, 517ms
/// at 100ms.
///
/// Dividing by 1000 pins the total reserve near 5.2% of the starting clock at
/// any time control. `None` means the clock isn't known yet, which is a reason
/// to be cautious rather than frugal — it takes the maximum.
pub fn move_overhead_for(initial_ms: Option<u64>) -> u64 {
    match initial_ms {
        Some(ms) if ms > 0 => (ms / 1000).clamp(MIN_MOVE_OVERHEAD_MS, MAX_MOVE_OVERHEAD_MS),
        _ => MAX_MOVE_OVERHEAD_MS,
    }
}

/// Which number to scale the reserve from, given a `GameStart`.
///
/// A named function because the obvious reading is wrong: `clock` is the time
/// control only on the FIRST send. The same frame is resent to a reconnecting
/// player with whatever time is LEFT, so scaling off it gave a seat rejoining a
/// 10+0 game at 12s the smallest reserve we allow. `time_control` is `None` only
/// on a server predating the field, where the clock is right on a fresh game and
/// wrong on a reconnect — strictly better than giving up the scaling entirely.
pub fn initial_ms_from(time_control: Option<TimeControl>, clock: &Clock) -> u64 {
    time_control.map(|tc| tc.initial_ms).unwrap_or(clock.white_ms)
}

/// Moves Stockfish assumes remain when a `go` carries no `movestogo`, and how
/// far above its resulting dead point to stop delegating. See
/// `apps/web/lib/timePolicy.ts` `takeoverBelowMs`, which must agree: the two
/// clients play the same games at the same time controls.
pub const SUDDEN_DEATH_MOVESTOGO: u64 = 50;
pub const TAKEOVER_FACTOR: u64 = 2;
/// Share of the remaining clock to spend once we have taken over. Mirrors the
/// browser seat's engine-mode fallback divisor.
const TAKEOVER_DIVISOR: u64 = 30;

/// Clock at or below which the engine's own manager stops being worth
/// delegating to: it subtracts `Move Overhead × (2 + movestogo)` before
/// allocating anything, so that product is where its allocation hits zero and
/// it starts answering in ~2ms.
pub fn takeover_below_ms(overhead_ms: u64) -> u64 {
    overhead_ms * (2 + SUDDEN_DEATH_MOVESTOGO) * TAKEOVER_FACTOR
}

/// How to ask the engine for this move.
///
/// A named decision rather than an `if` inside the socket loop, so the choice
/// itself can be tested: the loop below is a hundred lines of async I/O with no
/// harness, and "which branch did it take" is the part that matters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchPlan {
    /// `go movetime N`, alone. The clock is ours for this move.
    Takeover { movetime_ms: u64 },
    /// The normal clock-based `go`, with an optional `movetime` ceiling.
    Delegate { cap_ms: Option<u64> },
}

pub fn search_plan(policy: &TimePolicy, overhead_ms: u64, remaining_ms: Option<u64>) -> SearchPlan {
    match takeover_ms(policy, overhead_ms, remaining_ms) {
        Some(movetime_ms) => SearchPlan::Takeover { movetime_ms },
        None => SearchPlan::Delegate {
            cap_ms: move_cap_ms(policy, overhead_ms, remaining_ms),
        },
    }
}

/// The `movetime` to spend INSTEAD of delegating, or `None` to hand the clock
/// to the engine as usual.
///
/// An unknown clock keeps delegating: we cannot tell whether we are in the
/// collapse zone, and taking over on a guess would spend a floor's worth of
/// time every move of a game we might have plenty of clock for.
fn takeover_ms(policy: &TimePolicy, overhead_ms: u64, remaining_ms: Option<u64>) -> Option<u64> {
    let floor = policy.min_move_ms.filter(|m| *m > 0)?;
    let remaining = remaining_ms?;
    if remaining > takeover_below_ms(overhead_ms) {
        return None;
    }
    // The floor is a floor, not a target: spend a share of what's left when
    // that is more, so a seat with 25s does not crawl at the same speed as one
    // with 3s. Then clamp to time we actually have, and to any explicit ceiling.
    let want = (remaining / TAKEOVER_DIVISOR).max(floor);
    let usable = remaining.saturating_sub(overhead_ms).max(1);
    Some(want.min(usable).min(policy.max_move_ms.unwrap_or(u64::MAX)))
}

/// The `movetime` ceiling to attach to a `go`, given the policy and how much
/// clock this side actually has left. `None` means "no ceiling".
///
/// `remaining_ms` is itself an `Option` because our colour is only known after
/// `GameStart`. "Unknown" must not collapse to "zero left": that would floor
/// every search at 50ms and blunder the game away. An unknown clock gets the
/// flat ceiling and lets the engine's own manager do the rest.
///
/// The cap is also floored so a bot in deep time trouble is never told to
/// search for ~0ms: forcing a 1ms search would throw the game away rather than
/// lose on time.
///
/// This floor is on the CEILING, so it cannot lift a search the engine has
/// already decided to cut short — and it does not mean the low-clock case is
/// handled. It used to say the engine's own manager took care of that; it does
/// not. Stockfish collapses to ~2ms once the clock falls under
/// `Move Overhead × 52`, which is what `move_overhead_for` pushes down out of
/// normal play. Removing that floor entirely is a takeover, not a cap: a
/// `movetime` alongside `wtime` is only ever a ceiling (verified — `wtime 10000
/// movetime 1000` still spends 2ms), so the command has to be replaced.
fn move_cap_ms(policy: &TimePolicy, overhead_ms: u64, remaining_ms: Option<u64>) -> Option<u64> {
    const FLOOR_MS: u64 = 50;
    let max = policy.max_move_ms?;
    let Some(remaining) = remaining_ms else {
        return Some(max);
    };
    let usable = remaining.saturating_sub(overhead_ms);
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
    // The reserve in force right now. It starts cautious because the time
    // control is not known until `GameStart`, and is re-set there unless the
    // operator pinned one.
    let mut overhead_ms = opts
        .time
        .move_overhead_ms
        .unwrap_or_else(|| move_overhead_for(None));
    // Before the caller's options, so an explicit `--uci-option "Move
    // Overhead=..."` still wins.
    if engine.supports_option("Move Overhead") {
        engine
            .set_option("Move Overhead", &overhead_ms.to_string())
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
                clock,
                time_control,
                ..
            } => {
                my_color = Some(your_color);
                // The server's own number, rather than a flag that could
                // disagree with the game we were actually seated in. An operator
                // who pinned a reserve keeps it.
                //
                // `time_control`, NOT the clock: this frame is also resent to a
                // RECONNECTING player with whatever time is left, so reading the
                // clock gave a rejoining seat the smallest reserve we allow. The
                // clock stays only as a fallback for an older server, where it
                // is correct on the first `GameStart` and wrong only on a
                // reconnect.
                if opts.time.move_overhead_ms.is_none() && engine.supports_option("Move Overhead") {
                    overhead_ms = move_overhead_for(Some(initial_ms_from(time_control, &clock)));
                    engine
                        .set_option("Move Overhead", &overhead_ms.to_string())
                        .await?;
                }
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
                // `None` until GameStart names our colour. Kept as an Option
                // all the way into the budget: a missing colour is not a
                // zeroed clock (see `move_cap_ms`).
                let my_clock = my_color.map(|c| match c {
                    Color::White => clock.white_ms,
                    Color::Black => clock.black_ms,
                });
                // Try the opening book first; fall back to the engine.
                let book_move = opts.book.as_ref().and_then(|b| {
                    position_from(&moves_uci).and_then(|pos| b.pick(&pos, moves_uci.len() as u32))
                });
                let uci_move = match book_move {
                    Some(m) => {
                        println!("ply {ply}: book move {m}");
                        m
                    }
                    // Too little clock left for the engine's own manager to
                    // allocate from — spend our own budget instead of letting
                    // it answer in ~2ms. A REPLACEMENT, not an added ceiling.
                    None => match search_plan(&opts.time, overhead_ms, my_clock) {
                        SearchPlan::Takeover { movetime_ms } => {
                            println!("ply {ply}: low clock, searching {movetime_ms}ms");
                            engine.best_move_movetime(&moves_uci, movetime_ms).await?
                        }
                        SearchPlan::Delegate { cap_ms } => {
                            engine
                                .best_move_with_clock(
                                    &moves_uci,
                                    clock.white_ms,
                                    clock.black_ms,
                                    inc,
                                    inc,
                                    cap_ms,
                                )
                                .await?
                        }
                    },
                };
                println!("ply {ply}: playing {uci_move}");
                send(
                    &mut write,
                    &mut seq,
                    ClientMessage::Move {
                        game_id,
                        ply,
                        uci_move,
                        // Informational only (the server ignores it and keeps
                        // its own authoritative clock), so 0 is fine here.
                        client_clock_ms: my_clock.unwrap_or(0),
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
        assert_eq!(move_cap_ms(&TimePolicy::default(), 250, Some(180_000)), None);
    }

    #[test]
    fn caps_the_opening_search() {
        // The case this exists for: Stockfish would otherwise spend ~62s on
        // move 1 of a 10+0 game.
        assert_eq!(move_cap_ms(&capped(7_500), 250, Some(600_000)), Some(7_500));
    }

    #[test]
    fn never_budgets_time_the_clock_does_not_have() {
        // 2s left, 250ms of it owed to the network: search at most 1.75s, not
        // the 5s ceiling.
        assert_eq!(move_cap_ms(&capped(5_000), 250, Some(2_000)), Some(1_750));
    }

    #[test]
    fn keeps_a_floor_when_the_clock_is_nearly_gone() {
        // Below the overhead the subtraction saturates to zero. Telling the
        // engine to search for ~0ms throws the game away; losing on time was
        // already the likely outcome, so leave it a usable sliver. Note this
        // only stops US from asking for ~0ms — the engine can still choose it.
        assert_eq!(move_cap_ms(&capped(5_000), 250, Some(100)), Some(50));
        assert_eq!(move_cap_ms(&capped(5_000), 250, Some(0)), Some(50));
    }

    fn with_floor(min_move_ms: u64) -> TimePolicy {
        TimePolicy {
            min_move_ms: Some(min_move_ms),
            ..TimePolicy::default()
        }
    }

    #[test]
    fn delegation_continues_while_the_clock_is_healthy() {
        // The engine's own manager is better than ours when it has something to
        // work with, and it keeps the search extensions we cannot reproduce.
        // 250ms reserve → dead at 13s, handover at 26s.
        assert_eq!(takeover_ms(&with_floor(150), 250, Some(30_000)), None);
        // And a bot that never asked for a floor never hands over.
        assert_eq!(takeover_ms(&TimePolicy::default(), 250, Some(1_000)), None);
    }

    #[test]
    fn takes_over_once_the_engine_would_answer_instantly() {
        // Below the handover point the engine allocates ~nothing, so we budget.
        // A share of what's left, since the floor is a floor and not a target.
        assert_eq!(takeover_ms(&with_floor(150), 250, Some(24_000)), Some(800));
        assert_eq!(takeover_ms(&with_floor(150), 250, Some(3_000)), Some(150));
    }

    #[test]
    fn the_takeover_never_spends_time_the_clock_does_not_have() {
        // 200ms left, 250 of it owed to the network: the subtraction saturates,
        // and handing the engine a floor's worth here would flag outright.
        assert_eq!(takeover_ms(&with_floor(150), 250, Some(200)), Some(1));
        // An explicit ceiling still wins over the floor.
        let both = TimePolicy {
            min_move_ms: Some(5_000),
            max_move_ms: Some(400),
            ..TimePolicy::default()
        };
        assert_eq!(takeover_ms(&both, 250, Some(10_000)), Some(400));
    }

    #[test]
    fn an_unknown_clock_keeps_delegating() {
        // Our colour is unknown until GameStart, so we cannot tell whether we
        // are in the collapse zone. Taking over on a guess would spend a floor
        // every move of a game that may have plenty of clock.
        assert_eq!(takeover_ms(&with_floor(150), 250, None), None);
    }

    #[test]
    fn the_plan_switches_command_shape_at_the_handover() {
        // What the socket loop actually branches on. A `movetime` next to a
        // `wtime` is only a ceiling, so these two are different COMMANDS, not
        // different numbers — getting the branch wrong reintroduces the ~2ms
        // search with every unit test below still passing.
        let p = with_floor(150);
        assert_eq!(
            search_plan(&p, 250, Some(30_000)),
            SearchPlan::Delegate { cap_ms: None },
            "a healthy clock delegates",
        );
        assert_eq!(
            search_plan(&p, 250, Some(20_000)),
            SearchPlan::Takeover { movetime_ms: 666 },
            "below the handover the seat spends its own budget",
        );
        // A bot that never asked for a floor delegates all the way down, since
        // its engine's time manager is its author's business.
        assert_eq!(
            search_plan(&TimePolicy::default(), 250, Some(1_000)),
            SearchPlan::Delegate { cap_ms: None },
        );
        // And an explicit ceiling still rides along on the delegated command.
        assert_eq!(
            search_plan(&capped(7_500), 250, Some(600_000)),
            SearchPlan::Delegate {
                cap_ms: Some(7_500)
            },
        );
    }

    #[test]
    fn the_two_clients_agree_on_where_the_engine_dies() {
        // Mirrors apps/web/lib/timePolicy.ts `takeoverBelowMs`. They play the
        // same games at the same time controls; a drift here is a seat that
        // blunders in one client and not the other.
        assert_eq!(takeover_below_ms(250), 26_000);
        assert_eq!(takeover_below_ms(60), 6_240);
    }

    #[test]
    fn the_reserve_is_scaled_from_the_time_control_not_the_clock() {
        // `GameStart` is resent on RECONNECT with the time that is LEFT, so
        // scaling off `clock` handed a seat rejoining a 10+0 game at 12s the
        // floor (50ms) instead of 250ms — halving its network tolerance and
        // dragging its handover from 26s down to 5.2s.
        let tc = TimeControl {
            initial_ms: 600_000,
            increment_ms: 0,
        };
        let mid_game = Clock {
            white_ms: 12_000,
            black_ms: 30_000,
            increment_ms: 0,
        };
        assert_eq!(initial_ms_from(Some(tc), &mid_game), 600_000);
        assert_eq!(move_overhead_for(Some(initial_ms_from(Some(tc), &mid_game))), 250);

        // A server too old to send the field still gets the scaling from the
        // clock, which is right on a fresh game. Losing that would put every
        // seat back on a flat reserve until the server is deployed — the two do
        // not ship together.
        let fresh = Clock {
            white_ms: 60_000,
            black_ms: 60_000,
            increment_ms: 0,
        };
        assert_eq!(move_overhead_for(Some(initial_ms_from(None, &fresh))), 60);
    }

    #[test]
    fn the_reserve_scales_to_the_time_control() {
        // The whole point: a flat 250ms is 22% of a bullet clock once
        // Stockfish multiplies it by 52, and 2% of a rapid one.
        assert_eq!(move_overhead_for(Some(60_000)), 60); // 1+0
        assert_eq!(move_overhead_for(Some(180_000)), 180); // 3+0
        assert_eq!(move_overhead_for(Some(300_000)), 250); // 5+0, at the cap
        assert_eq!(move_overhead_for(Some(600_000)), 250); // 10+0, at the cap
    }

    #[test]
    fn an_unknown_time_control_reserves_the_most_not_the_least() {
        // `None` is "GameStart hasn't happened yet", which is a reason to be
        // careful. Taking the floor here would risk flagging on latency in
        // exactly the case where we know least about the game.
        assert_eq!(move_overhead_for(None), MAX_MOVE_OVERHEAD_MS);
        assert_eq!(move_overhead_for(Some(0)), MAX_MOVE_OVERHEAD_MS);
        // And a clock so short that the scaled value would round to nothing
        // still gets a usable reserve.
        assert_eq!(move_overhead_for(Some(1_000)), MIN_MOVE_OVERHEAD_MS);
    }

    #[test]
    fn an_unknown_clock_is_not_an_empty_clock() {
        // Our colour is unknown until GameStart. If that collapsed to "0ms
        // left" the search would be floored at 50ms and the bot would blunder
        // the game away — a silent failure, since nothing else reads the
        // colour on this path. Fall back to the flat ceiling instead.
        assert_eq!(move_cap_ms(&capped(5_000), 250, None), Some(5_000));
        assert_eq!(move_cap_ms(&TimePolicy::default(), 250, None), None);
    }
}
