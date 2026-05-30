//! UCI engine driver.
//!
//! Wraps a user-supplied UCI engine subprocess (Stockfish by default) and
//! exposes the small slice of the protocol the client needs: handshake, option
//! setting, and "given this move history and a time budget, what's your move?".
//!
//! The engine is always driven with the *full* move list (`position startpos
//! moves ...`) so each `go` is self-contained — the engine never relies on
//! hidden internal state, which keeps the server the sole authority.

use std::process::Stdio;

use anyhow::{anyhow, Context, Result};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

/// A discovered UCI option (as advertised by the engine's `uci` handshake).
#[derive(Debug, Clone)]
pub struct UciOption {
    pub name: String,
    pub kind: String,
    pub default: Option<String>,
    pub min: Option<String>,
    pub max: Option<String>,
}

/// A running UCI engine.
pub struct UciEngine {
    child: Child,
    stdin: ChildStdin,
    stdout: Lines<BufReader<ChildStdout>>,
    /// Engine `id name` reported during the handshake.
    pub name: String,
    /// All options the engine advertised, so the UI can render them.
    pub options: Vec<UciOption>,
}

impl UciEngine {
    /// Launch an engine binary and perform the `uci` handshake.
    pub async fn launch(path: &str, args: &[String]) -> Result<Self> {
        let mut child = Command::new(path)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("failed to spawn engine '{path}'"))?;

        let stdin = child.stdin.take().context("engine stdin unavailable")?;
        let stdout = child.stdout.take().context("engine stdout unavailable")?;
        let stdout = BufReader::new(stdout).lines();

        let mut engine = UciEngine {
            child,
            stdin,
            stdout,
            name: String::new(),
            options: Vec::new(),
        };
        engine.handshake().await?;
        Ok(engine)
    }

    async fn send(&mut self, line: &str) -> Result<()> {
        self.stdin.write_all(line.as_bytes()).await?;
        self.stdin.write_all(b"\n").await?;
        self.stdin.flush().await?;
        Ok(())
    }

    async fn next_line(&mut self) -> Result<String> {
        self.stdout
            .next_line()
            .await?
            .ok_or_else(|| anyhow!("engine closed its output stream"))
    }

    /// `uci` -> read options + id, until `uciok`.
    async fn handshake(&mut self) -> Result<()> {
        self.send("uci").await?;
        loop {
            let line = self.next_line().await?;
            if let Some(rest) = line.strip_prefix("id name ") {
                self.name = rest.trim().to_string();
            } else if line.starts_with("option name ") {
                if let Some(opt) = parse_option(&line) {
                    self.options.push(opt);
                }
            } else if line.trim() == "uciok" {
                break;
            }
        }
        Ok(())
    }

    /// Set a UCI option (e.g. Threads, Hash, MultiPV).
    pub async fn set_option(&mut self, name: &str, value: &str) -> Result<()> {
        self.send(&format!("setoption name {name} value {value}"))
            .await
    }

    /// Block until the engine reports `readyok`.
    pub async fn is_ready(&mut self) -> Result<()> {
        self.send("isready").await?;
        loop {
            if self.next_line().await?.trim() == "readyok" {
                return Ok(());
            }
        }
    }

    /// Signal a fresh game and wait for the engine to be ready.
    pub async fn new_game(&mut self) -> Result<()> {
        self.send("ucinewgame").await?;
        self.is_ready().await
    }

    /// Ask for the best move given the full UCI move history and clock state.
    /// Returns the chosen move in UCI long-algebraic notation.
    pub async fn best_move_with_clock(
        &mut self,
        moves_uci: &[String],
        white_ms: u64,
        black_ms: u64,
        winc_ms: u64,
        binc_ms: u64,
    ) -> Result<String> {
        self.set_position(moves_uci).await?;
        self.send(&format!(
            "go wtime {white_ms} btime {black_ms} winc {winc_ms} binc {binc_ms}"
        ))
        .await?;
        self.read_best_move().await
    }

    /// Ask for the best move using a fixed per-move time budget.
    pub async fn best_move_movetime(
        &mut self,
        moves_uci: &[String],
        movetime_ms: u64,
    ) -> Result<String> {
        self.set_position(moves_uci).await?;
        self.send(&format!("go movetime {movetime_ms}")).await?;
        self.read_best_move().await
    }

    async fn set_position(&mut self, moves_uci: &[String]) -> Result<()> {
        let cmd = if moves_uci.is_empty() {
            "position startpos".to_string()
        } else {
            format!("position startpos moves {}", moves_uci.join(" "))
        };
        self.send(&cmd).await
    }

    async fn read_best_move(&mut self) -> Result<String> {
        loop {
            let line = self.next_line().await?;
            if let Some(rest) = line.strip_prefix("bestmove ") {
                let mv = rest
                    .split_whitespace()
                    .next()
                    .ok_or_else(|| anyhow!("malformed bestmove line: {line}"))?;
                if mv == "(none)" {
                    return Err(anyhow!("engine has no legal move"));
                }
                return Ok(mv.to_string());
            }
            // Other lines are `info ...`; ignore for now (could forward as telemetry).
        }
    }

    /// Cleanly stop the engine.
    pub async fn quit(mut self) -> Result<()> {
        let _ = self.send("quit").await;
        let _ = self.child.wait().await;
        Ok(())
    }
}

fn parse_option(line: &str) -> Option<UciOption> {
    // `option name <Name with spaces> type <t> [default <d>] [min <m>] [max <M>] [var ...]`
    let rest = line.strip_prefix("option name ")?;
    let type_idx = rest.find(" type ")?;
    let name = rest[..type_idx].trim().to_string();
    let after = &rest[type_idx + " type ".len()..];
    let tokens: Vec<&str> = after.split_whitespace().collect();
    let kind = tokens.first().copied().unwrap_or("").to_string();

    let field = |key: &str| -> Option<String> {
        tokens
            .iter()
            .position(|t| *t == key)
            .and_then(|i| tokens.get(i + 1))
            .map(|s| s.to_string())
    };

    Some(UciOption {
        name,
        kind,
        default: field("default"),
        min: field("min"),
        max: field("max"),
    })
}
