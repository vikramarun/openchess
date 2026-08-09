//! Gauntlet mode: keep playing back-to-back games at a fixed tier until the
//! session is stopped (or a game cap is hit). This drives the existing tier
//! queue + per-game escrow — each game is an independent 1v1 settlement.

use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};

use crate::book::OpeningBook;
use crate::net::{play, PlayOpts, TimePolicy};

pub struct GauntletOpts {
    pub http_server: String,
    pub stake: Option<String>,
    pub initial_secs: u64,
    pub increment_secs: u64,
    pub count: u32,
    pub engine_path: String,
    pub engine_args: Vec<String>,
    /// Opening book, already loaded and shared across the session's games.
    pub book: Option<std::sync::Arc<OpeningBook>>,
    pub auth_token: Option<String>,
    /// Per-move clock budgeting, applied to every game in the session.
    pub time: TimePolicy,
}

pub(crate) fn ws_base(http: &str) -> String {
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

    let book = opts.book.clone();

    // Mutable: a server deploy voids every in-memory session mid-run, and the
    // queue loop below re-authenticates rather than aborting the whole session
    // on the first 401 (the same lesson the agent loop learned in connect.rs).
    let mut auth_token = opts.auth_token.clone();

    let with_auth = |rb: reqwest::RequestBuilder, tok: &Option<String>| match tok {
        Some(t) => rb.bearer_auth(t),
        None => rb,
    };

    // Start the session.
    let start = with_auth(
        client.post(format!("{http}/gauntlet/start")).json(&json!({
            "stake": opts.stake,
            "initial_secs": opts.initial_secs,
            "increment_secs": opts.increment_secs,
        })),
        &auth_token,
    );
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

        // Join the tier queue, attributing the game to this session. On a 401,
        // re-authenticate once and retry: the session lives in the server's
        // process memory, so a mid-run deploy voids it — aborting a staked
        // session over that would strand the whole run.
        let ticket: Value = loop {
            let q = with_auth(
                client.post(format!("{http}/queue")).json(&json!({
                    "stake": opts.stake,
                    "initial_secs": opts.initial_secs,
                    "increment_secs": opts.increment_secs,
                    "session_id": session_id,
                })),
                &auth_token,
            );
            match q.send().await?.error_for_status() {
                Ok(resp) => break resp.json().await?,
                Err(e)
                    if e.status() == Some(reqwest::StatusCode::UNAUTHORIZED)
                        && auth_token.is_some() =>
                {
                    eprintln!("session rejected; re-authenticating...");
                    match crate::auth::resolve_session(&client, &http, None, None).await? {
                        Some(s) => {
                            println!("signed in as {}", s.address);
                            auth_token = Some(s.token);
                        }
                        // A pasted --auth-token or claimed --code can't be
                        // re-minted here; only OPENCHESS_WALLET_KEY can.
                        None => {
                            return Err(anyhow!(
                                "session expired and no OPENCHESS_WALLET_KEY set to \
                                 re-authenticate; restart with a fresh token"
                            ))
                        }
                    }
                }
                Err(e) => return Err(e.into()),
            }
        };
        let ticket_id = ticket["ticket_id"]
            .as_str()
            .ok_or_else(|| anyhow!("no ticket_id"))?
            .to_string();

        // Wait for a pairing. The bearer rides along so the server CAN one day
        // gate a wagered ticket's token on the owner wallet — today it doesn't,
        // because clients shipped before this line polled anonymously.
        println!("game {}/{}: waiting for an opponent...", i + 1, opts.count);
        let (game_id, token) = loop {
            let t: Value = with_auth(
                client.get(format!("{http}/queue/{ticket_id}")),
                &auth_token,
            )
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

        play(PlayOpts {
            server: ws.clone(),
            game_id,
            token,
            engine_path: opts.engine_path.clone(),
            engine_args: opts.engine_args.clone(),
            book: book.clone(),
            uci_options: Vec::new(),
            time: opts.time,
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
    let _ = with_auth(
        client.post(format!("{http}/gauntlet/{session_id}/stop")),
        &auth_token,
    )
    .send()
    .await;
    println!("gauntlet finished");
    Ok(())
}
