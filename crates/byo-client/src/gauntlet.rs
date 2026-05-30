//! Gauntlet mode: keep playing back-to-back games at a fixed tier until the
//! session is stopped (or a game cap is hit). This drives the existing tier
//! queue + per-game escrow — each game is an independent 1v1 settlement.

use std::path::Path;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};

use crate::book::OpeningBook;
use crate::net::{play, PlayOpts};

pub struct GauntletOpts {
    pub http_server: String,
    pub stake: Option<String>,
    pub initial_secs: u64,
    pub increment_secs: u64,
    pub count: u32,
    pub engine_path: String,
    pub engine_args: Vec<String>,
    pub book_path: Option<String>,
    pub book_max_ply: u32,
    pub auth_token: Option<String>,
}

fn ws_base(http: &str) -> String {
    // http://host -> ws://host, https://host -> wss://host
    if let Some(rest) = http.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = http.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        http.to_string()
    }
}

pub async fn run_gauntlet(opts: GauntletOpts) -> Result<()> {
    let http = opts.http_server.trim_end_matches('/').to_string();
    let ws = ws_base(&http);
    let client = reqwest::Client::new();

    let auth = |rb: reqwest::RequestBuilder| match &opts.auth_token {
        Some(t) => rb.bearer_auth(t),
        None => rb,
    };

    // Start the session.
    let start = auth(client.post(format!("{http}/gauntlet/start")).json(&json!({
        "stake": opts.stake,
        "initial_secs": opts.initial_secs,
        "increment_secs": opts.increment_secs,
    })));
    let resp: Value = start
        .send()
        .await?
        .error_for_status()
        .context("gauntlet/start failed")?
        .json()
        .await?;
    let session_id = resp["session_id"]
        .as_str()
        .ok_or_else(|| anyhow!("no session_id"))?
        .to_string();
    println!("gauntlet session {session_id} (tier={:?})", opts.stake);

    for i in 0..opts.count {
        // Honor a stop request.
        let status: Value = client
            .get(format!("{http}/gauntlet/{session_id}"))
            .send()
            .await?
            .json()
            .await?;
        if status["status"] == "stopped" {
            println!("session stopped");
            break;
        }

        // Join the tier queue, attributing the game to this session.
        let q = auth(client.post(format!("{http}/queue")).json(&json!({
            "stake": opts.stake,
            "initial_secs": opts.initial_secs,
            "increment_secs": opts.increment_secs,
            "session_id": session_id,
        })));
        let ticket: Value = q.send().await?.error_for_status()?.json().await?;
        let ticket_id = ticket["ticket_id"]
            .as_str()
            .ok_or_else(|| anyhow!("no ticket_id"))?
            .to_string();

        // Wait for a pairing.
        println!("game {}/{}: waiting for an opponent…", i + 1, opts.count);
        let (game_id, token) = loop {
            let t: Value = client
                .get(format!("{http}/queue/{ticket_id}"))
                .send()
                .await?
                .json()
                .await?;
            if t["status"] == "matched" {
                break (
                    t["game_id"].as_str().unwrap_or_default().to_string(),
                    t["token"].as_str().unwrap_or_default().to_string(),
                );
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        };

        // Open the book fresh for this game (cheap).
        let book = match &opts.book_path {
            Some(p) => Some(OpeningBook::open(Path::new(p), opts.book_max_ply)?),
            None => None,
        };
        play(PlayOpts {
            server: ws.clone(),
            game_id,
            token,
            engine_path: opts.engine_path.clone(),
            engine_args: opts.engine_args.clone(),
            book,
        })
        .await?;

        // Print running record.
        let s: Value = client
            .get(format!("{http}/gauntlet/{session_id}"))
            .send()
            .await?
            .json()
            .await?;
        println!(
            "  record: {}W / {}L / {}D over {} games",
            s["wins"], s["losses"], s["draws"], s["games"]
        );
    }

    // Stop the session.
    let _ = auth(client.post(format!("{http}/gauntlet/{session_id}/stop")))
        .send()
        .await;
    println!("gauntlet finished");
    Ok(())
}
