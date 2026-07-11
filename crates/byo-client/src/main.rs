//! Bring-your-own-engine client.
//!
//! For the vertical slice this binary supports a `selfplay` subcommand that
//! referees two local UCI engines against each other using the authoritative
//! `game-engine`, printing the live game and final result. This exercises the
//! whole engine-orchestration path (spawn, handshake, position/go/bestmove,
//! server-side clock + legality + terminal detection) against a real engine
//! before the networked `play` path is wired up.

mod auth;
mod book;
mod connect;
mod engine;
mod gauntlet;
mod net;

use std::time::Instant;

use anyhow::Result;
use clap::{Parser, Subcommand};
use game_engine::{Game, Status};
use protocol::TimeControl;

use crate::engine::UciEngine;
use crate::net::{play, PlayOpts};

#[derive(Parser)]
#[command(
    name = "chess-client",
    version,
    about = "Bring-your-own-engine chess client"
)]
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
    /// Gauntlet: keep playing back-to-back games at a fixed tier until stopped.
    Gauntlet {
        /// HTTP base URL of the server (ws URL is derived from it).
        #[arg(long, default_value = "http://127.0.0.1:8080")]
        server: String,
        /// Stake tier in USDC base units (omit for a casual gauntlet).
        #[arg(long)]
        stake: Option<String>,
        #[arg(long, default_value_t = 60)]
        initial_secs: u64,
        #[arg(long, default_value_t = 0)]
        increment_secs: u64,
        /// Maximum number of games to play.
        #[arg(long, default_value_t = 10)]
        count: u32,
        #[arg(long, default_value = "stockfish")]
        engine: String,
        #[arg(long = "engine-arg")]
        engine_args: Vec<String>,
        #[arg(long)]
        book: Option<String>,
        #[arg(long, default_value_t = 16)]
        book_max_ply: u32,
        /// SIWE session token (Bearer), required for a staked gauntlet.
        #[arg(long)]
        auth_token: Option<String>,
    },
    /// Put your engine online as a bot bound to your wallet. By default you
    /// then drive it from the website (start/join games there — the seat is
    /// pushed here and the engine plays). `--auto` instead matches unattended.
    Connect {
        /// HTTP base URL of the server (ws URL is derived from it).
        #[arg(long, default_value = "https://openchess.fly.dev")]
        server: String,
        /// Path to your UCI engine binary.
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
        /// Display name shown to opponents (defaults to the engine name).
        #[arg(long)]
        name: Option<String>,
        /// UCI option applied to every game, as Name=Value (repeatable),
        /// e.g. --uci-option "Threads=4" --uci-option "Skill Level=15".
        #[arg(long = "uci-option", value_parser = parse_uci_option)]
        uci_options: Vec<(String, String)>,
        /// Single-use pairing code from the web app's "Connect your engine"
        /// page. Required unless --auth-token / OPENCHESS_WALLET_KEY is used.
        #[arg(long)]
        code: Option<String>,
        /// Existing SIWE session token (alternative to --code).
        #[arg(long)]
        auth_token: Option<String>,
        /// Autopilot: match unattended (accept-or-post loop) instead of being
        /// driven from the website.
        #[arg(long)]
        auto: bool,
        /// Autopilot: stake per game in USDC base units (omit for free games).
        #[arg(long)]
        stake: Option<String>,
        /// Autopilot: time control to seek.
        #[arg(long, default_value_t = 180)]
        initial_secs: u64,
        #[arg(long, default_value_t = 2)]
        increment_secs: u64,
        /// Autopilot: stop after this many games (0 = play until Ctrl-C).
        #[arg(long, default_value_t = 0)]
        games: u32,
    },
    /// Print a SIWE session token for this wallet (for scripting). Uses
    /// OPENCHESS_WALLET_KEY or claims a --code from the web app.
    Login {
        #[arg(long, default_value = "https://openchess.fly.dev")]
        server: String,
        #[arg(long)]
        code: Option<String>,
    },
}

/// Parse `Name=Value` (the name may contain spaces, e.g. "Skill Level=15").
fn parse_uci_option(s: &str) -> Result<(String, String), String> {
    match s.split_once('=') {
        Some((k, v)) if !k.trim().is_empty() => Ok((k.trim().to_string(), v.trim().to_string())),
        _ => Err(format!("expected Name=Value, got '{s}'")),
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    // The dependency tree enables both rustls crypto backends (ring via
    // tungstenite, aws-lc-rs via alloy), so rustls needs an explicit
    // process-level default or every wss:// connect panics.
    let _ = rustls::crypto::ring::default_provider().install_default();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
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
                Some(p) => Some(std::sync::Arc::new(crate::book::OpeningBook::open(
                    std::path::Path::new(&p),
                    book_max_ply,
                )?)),
                None => None,
            };
            play(PlayOpts {
                server,
                game_id: game,
                token,
                engine_path: engine,
                engine_args,
                book,
                uci_options: Vec::new(),
            })
            .await
        }
        Command::Gauntlet {
            server,
            stake,
            initial_secs,
            increment_secs,
            count,
            engine,
            engine_args,
            book,
            book_max_ply,
            auth_token,
        } => {
            gauntlet::run_gauntlet(gauntlet::GauntletOpts {
                http_server: server,
                stake,
                initial_secs,
                increment_secs,
                count,
                engine_path: engine,
                engine_args,
                book_path: book,
                book_max_ply,
                auth_token,
            })
            .await
        }
        Command::Connect {
            server,
            engine,
            engine_args,
            book,
            book_max_ply,
            name,
            uci_options,
            code,
            auth_token,
            auto,
            stake,
            initial_secs,
            increment_secs,
            games,
        } => {
            connect::run_connect(connect::ConnectOpts {
                http_server: server,
                name,
                engine_path: engine,
                engine_args,
                book_path: book,
                book_max_ply,
                uci_options,
                auth_token,
                code,
                auto,
                stake,
                initial_secs,
                increment_secs,
                games,
            })
            .await
        }
        Command::Login { server, code } => {
            let client = reqwest::Client::new();
            let http = server.trim_end_matches('/').to_string();
            let session = auth::resolve_session(&client, &http, None, code)
                .await?
                .ok_or_else(|| {
                    anyhow::anyhow!("no credential: pass --code or set OPENCHESS_WALLET_KEY")
                })?;
            println!("address: {}", session.address);
            println!("token:   {}", session.token);
            println!("(session bearer token, expires in 24h — treat it like a password)");
            Ok(())
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
