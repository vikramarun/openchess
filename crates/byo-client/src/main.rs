//! Bring-your-own-engine client.
//!
//! For the vertical slice this binary supports a `selfplay` subcommand that
//! referees two local UCI engines against each other using the authoritative
//! `game-engine`, printing the live game and final result. This exercises the
//! whole engine-orchestration path (spawn, handshake, position/go/bestmove,
//! server-side clock + legality + terminal detection) against a real engine
//! before the networked `play` path is wired up.

mod book;
mod engine;
mod net;

use std::time::Instant;

use anyhow::Result;
use clap::{Parser, Subcommand};
use game_engine::{Game, Status};
use protocol::TimeControl;

use crate::engine::UciEngine;
use crate::net::{play, PlayOpts};

#[derive(Parser)]
#[command(name = "chess-client", about = "Bring-your-own-engine chess client")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Referee two local UCI engines against each other (no network).
    Selfplay {
        /// Path to the white engine binary.
        #[arg(long, default_value = "stockfish")]
        white: String,
        /// Path to the black engine binary.
        #[arg(long, default_value = "stockfish")]
        black: String,
        /// Per-move time budget in milliseconds handed to each engine.
        #[arg(long, default_value_t = 100)]
        movetime_ms: u64,
        /// Initial clock per side, in seconds.
        #[arg(long, default_value_t = 60)]
        initial_secs: u64,
        /// Increment per move, in seconds.
        #[arg(long, default_value_t = 1)]
        increment_secs: u64,
        /// Safety cap on the number of plies.
        #[arg(long, default_value_t = 400)]
        max_plies: u32,
    },
    /// Connect to the game server and play one networked game with a token.
    Play {
        /// WebSocket base URL of the server.
        #[arg(long, default_value = "ws://127.0.0.1:8080")]
        server: String,
        /// Game id to join.
        #[arg(long)]
        game: String,
        /// Launch token authorizing a seat in the game.
        #[arg(long)]
        token: String,
        /// Path to the UCI engine binary.
        #[arg(long, default_value = "stockfish")]
        engine: String,
        /// Extra argument to pass to the engine (repeatable).
        #[arg(long = "engine-arg")]
        engine_args: Vec<String>,
        /// Optional Polyglot opening book (.bin) consulted before the engine.
        #[arg(long)]
        book: Option<String>,
        /// Stop using the book after this many plies.
        #[arg(long, default_value_t = 16)]
        book_max_ply: u32,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let cli = Cli::parse();
    match cli.command {
        Command::Selfplay {
            white,
            black,
            movetime_ms,
            initial_secs,
            increment_secs,
            max_plies,
        } => {
            selfplay(SelfplayOpts {
                white,
                black,
                movetime_ms,
                initial_secs,
                increment_secs,
                max_plies,
            })
            .await
        }
        Command::Play {
            server,
            game,
            token,
            engine,
            engine_args,
            book,
            book_max_ply,
        } => {
            let book = match book {
                Some(p) => Some(crate::book::OpeningBook::open(
                    std::path::Path::new(&p),
                    book_max_ply,
                )?),
                None => None,
            };
            play(PlayOpts {
                server,
                game_id: game,
                token,
                engine_path: engine,
                engine_args,
                book,
            })
            .await
        }
    }
}

struct SelfplayOpts {
    white: String,
    black: String,
    movetime_ms: u64,
    initial_secs: u64,
    increment_secs: u64,
    max_plies: u32,
}

async fn selfplay(opts: SelfplayOpts) -> Result<()> {
    let tc = TimeControl {
        initial_ms: opts.initial_secs * 1_000,
        increment_ms: opts.increment_secs * 1_000,
    };

    println!("Launching white engine: {}", opts.white);
    let mut white = UciEngine::launch(&opts.white, &[]).await?;
    white.set_option("MultiPV", "1").await?;
    white.new_game().await?;

    println!("Launching black engine: {}", opts.black);
    let mut black = UciEngine::launch(&opts.black, &[]).await?;
    black.set_option("MultiPV", "1").await?;
    black.new_game().await?;

    println!("White: {}\nBlack: {}\n", white.name, black.name);

    let started = Instant::now();
    let now_ms = || started.elapsed().as_millis() as u64;

    let mut game = Game::new(tc, now_ms());

    while !game.is_over() && game.ply() < opts.max_plies {
        // Flag check before asking the engine to move.
        if game.flag_if_expired(now_ms()).is_some() {
            break;
        }

        let mover = game.turn();
        let clock = game.clock(now_ms());
        let history: Vec<String> = game.moves_uci().to_vec();

        let engine = match mover {
            protocol::Color::White => &mut white,
            protocol::Color::Black => &mut black,
        };

        // Use the smaller of the per-move budget and the side's remaining time.
        let remaining = match mover {
            protocol::Color::White => clock.white_ms,
            protocol::Color::Black => clock.black_ms,
        };
        let budget = opts.movetime_ms.min(remaining.saturating_sub(50).max(1));
        let uci_move = engine.best_move_movetime(&history, budget).await?;

        match game.play_move(&uci_move, now_ms()) {
            Ok(applied) => {
                let move_no = (applied.ply + 1) / 2;
                let tag = if applied.ply % 2 == 1 { "." } else { "..." };
                println!(
                    "{move_no}{tag} {san:8} (w {w:.1}s / b {b:.1}s)",
                    san = applied.san,
                    w = applied.clock.white_ms as f64 / 1000.0,
                    b = applied.clock.black_ms as f64 / 1000.0,
                );
            }
            Err(e) => {
                eprintln!("move error from {mover:?}: {e}");
                break;
            }
        }
    }

    white.quit().await?;
    black.quit().await?;

    println!("\nPGN: {}", game.pgn());
    match game.status() {
        Status::Finished(result) => {
            let outcome = match result.winner {
                Some(protocol::Color::White) => "1-0 (White wins)",
                Some(protocol::Color::Black) => "0-1 (Black wins)",
                None => "1/2-1/2 (Draw)",
            };
            println!("Result: {outcome} by {:?}", result.reason);
        }
        Status::Ongoing => println!("Result: unfinished (hit ply cap)"),
    }

    Ok(())
}
