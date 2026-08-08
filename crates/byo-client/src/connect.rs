//! `connect`: put your engine online as a bot you control from the web.
//!
//! Default (agent) mode — the playchess/lichess-bot model: authenticate once,
//! register the engine (name + its UCI options) over a persistent WebSocket,
//! and wait. The website is the remote control: when you start or join a game
//! there with your bot, the server pushes the seat here and the engine plays.
//! No tokens to shuttle, no command to re-run per game.
//!
//! `--auto` (autopilot) mode — unattended matchmaking for headless bots:
//! accept a compatible open challenge when one exists, otherwise post one and
//! wait; repeat until the game cap or Ctrl-C (which withdraws the challenge).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use protocol::{AgentServerEnvelope, AgentToServer, Envelope, ServerToAgent, UciOptionInfo};
use serde_json::{json, Value};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use crate::auth::{resolve_session, Session};
use crate::book::OpeningBook;
use crate::engine::UciEngine;
use crate::gauntlet::ws_base;
use crate::net::{play, PlayOpts};

pub struct ConnectOpts {
    pub http_server: String,
    /// Display name shown to opponents; defaults to the engine name.
    pub name: Option<String>,
    pub engine_path: String,
    pub engine_args: Vec<String>,
    pub book_path: Option<String>,
    pub book_max_ply: u32,
    /// UCI options set from the CLI, applied to every game.
    pub uci_options: Vec<(String, String)>,
    pub auth_token: Option<String>,
    pub code: Option<String>,
    /// Autopilot: match unattended instead of being driven from the web.
    pub auto: bool,
    /// Autopilot only — stake per game in USDC base units; None = free.
    pub stake: Option<String>,
    pub initial_secs: u64,
    pub increment_secs: u64,
    /// Autopilot only — stop after this many games (0 = until Ctrl-C).
    pub games: u32,
}

pub async fn run_connect(opts: ConnectOpts) -> Result<()> {
    let http = opts.http_server.trim_end_matches('/').to_string();
    let client = reqwest::Client::new();

    // A bot is always wallet-bound: its games count toward a profile and may
    // carry stakes, so anonymous bots don't exist.
    let session = sign_in(&client, &http, &opts).await?;
    println!("signed in as {}", session.address);

    // Probe the engine once: verify it runs, and collect its identity and UCI
    // options so the web app can render a settings panel for it.
    let (engine_name, engine_options) = {
        let engine = UciEngine::launch(&opts.engine_path, &opts.engine_args).await?;
        let name = engine.name.clone();
        let options = engine.options.clone();
        engine.quit().await?;
        (name, options)
    };
    println!("engine: {engine_name}");
    // Open the book ONCE and share it across games: real books are large
    // (full read + sort), and a fallible per-game open inside the seat loop
    // would turn a moved file into a silent forfeit machine.
    let book: Option<Arc<OpeningBook>> = match &opts.book_path {
        Some(b) => {
            let book = OpeningBook::open(std::path::Path::new(b), opts.book_max_ply)?;
            println!("opening book: {b} (≤ ply {})", opts.book_max_ply);
            Some(Arc::new(book))
        }
        None => None,
    };

    if opts.auto {
        run_autopilot(&client, &http, &opts, session, &engine_name, book).await
    } else {
        run_agent(&http, &opts, &session, &engine_name, engine_options, book).await
    }
}

/// Sign in, retrying a failure a few times before giving up.
///
/// A transient sign-in failure used to kill the process. Under a supervisor
/// (`scripts/house-bot.sh` runs four of these side by side) that is worse than
/// it sounds: the replacement process posts a *fresh* challenge while the dead
/// one's challenge stays in the park for its full TTL, since only the SIGTERM
/// path withdraws offers and a crash never reaches it. The park fills with
/// ghost offers from the same wallet, which the autopilots then match against
/// each other. Retrying in place keeps one identity and one standing offer.
///
/// Bounded rather than infinite: a wrong key or a domain mismatch fails the
/// same way every time, and exiting lets the supervisor surface it.
async fn sign_in(client: &reqwest::Client, http: &str, opts: &ConnectOpts) -> Result<Session> {
    const ATTEMPTS: u32 = 5;
    let mut backoff = 2u64;
    let mut last: Option<anyhow::Error> = None;
    for attempt in 1..=ATTEMPTS {
        match resolve_session(client, http, opts.auth_token.clone(), opts.code.clone()).await {
            // No credential configured at all is a usage error, not a
            // transient one — retrying can't conjure a wallet.
            Ok(None) => {
                return Err(anyhow!(
                    "connecting a bot requires your wallet: pass --code (from the web app's \
                     Connect page), --auth-token, or set OPENCHESS_WALLET_KEY"
                ))
            }
            Ok(Some(s)) => return Ok(s),
            Err(e) => {
                if attempt < ATTEMPTS {
                    eprintln!("sign-in failed ({e:#}); retrying in {backoff}s");
                    tokio::time::sleep(Duration::from_secs(backoff)).await;
                    backoff = (backoff * 2).min(30);
                }
                last = Some(e);
            }
        }
    }
    Err(last.unwrap().context("sign-in failed after retries"))
}

/// Did this failure come back as HTTP 401? A session lives in the server's
/// memory, so any restart there voids it while this process is still holding
/// it — worth re-authenticating for rather than retrying the same dead token.
fn is_unauthorized(e: &anyhow::Error) -> bool {
    e.chain().any(|c| {
        c.downcast_ref::<reqwest::Error>()
            .and_then(|re| re.status())
            .is_some_and(|s| s == reqwest::StatusCode::UNAUTHORIZED)
    })
}

// ---------------------------------------------------------------------------
// Agent mode (default): web-driven
// ---------------------------------------------------------------------------

async fn run_agent(
    http: &str,
    opts: &ConnectOpts,
    session: &Session,
    engine_name: &str,
    engine_options: Vec<UciOptionInfo>,
    book: Option<Arc<OpeningBook>>,
) -> Result<()> {
    let ws = ws_base(http);
    // No token in the URL — auth travels in the Hello frame so the 24h
    // session credential never lands in proxy/access logs.
    let ws_url = format!("{ws}/ws/agent");
    let mut backoff = 3u64;
    loop {
        match agent_session(
            &ws_url,
            &ws,
            opts,
            session,
            engine_name,
            &engine_options,
            &book,
        )
        .await
        {
            Ok(()) => {
                // Server closed the socket (deploy/restart) — reconnect.
                eprintln!("connection closed; reconnecting…");
                backoff = 3;
            }
            Err(e) => {
                eprintln!("agent error: {e:#}; retrying in {backoff}s");
            }
        }
        tokio::time::sleep(Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(30);
    }
}

/// Send an agent envelope over the write half of the control socket.
async fn send_agent<S>(write: &mut S, seq: &mut u64, msg: AgentToServer) -> Result<()>
where
    S: SinkExt<Message> + Unpin,
    <S as futures_util::Sink<Message>>::Error: std::error::Error + Send + Sync + 'static,
{
    *seq += 1;
    let text = serde_json::to_string(&Envelope::new(*seq, 0, msg))?;
    write.send(Message::Text(text.into())).await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn agent_session(
    ws_url: &str,
    ws_base_url: &str,
    opts: &ConnectOpts,
    session: &Session,
    engine_name: &str,
    engine_options: &[UciOptionInfo],
    book: &Option<Arc<OpeningBook>>,
) -> Result<()> {
    let (ws, _resp) = connect_async(ws_url)
        .await
        .context("agent connect failed")?;
    let (mut write, mut read) = ws.split();
    let mut seq = 0u64;

    send_agent(
        &mut write,
        &mut seq,
        AgentToServer::Hello {
            token: session.token.clone(),
            name: opts.name.clone(),
            engine: engine_name.to_string(),
            options: engine_options.to_vec(),
            client_version: env!("CARGO_PKG_VERSION").to_string(),
        },
    )
    .await?;

    while let Some(frame) = read.next().await {
        let text = match frame? {
            Message::Text(t) => t.to_string(),
            Message::Close(_) => return Ok(()),
            _ => continue,
        };
        let Ok(env) = serde_json::from_str::<AgentServerEnvelope>(&text) else {
            continue;
        };
        match env.msg {
            ServerToAgent::Registered { wallet } => {
                println!(
                    "✓ your bot is online as {wallet} — start or join games from the website; \
                     this window plays them"
                );
            }
            ServerToAgent::AssignSeat {
                game_id,
                token,
                color,
                stake,
                uci_options,
                ..
            } => {
                println!(
                    "seat assigned: {color:?} in {game_id}{}",
                    stake
                        .as_deref()
                        .map(|s| format!(" (stake {s})"))
                        .unwrap_or_default()
                );
                send_agent(
                    &mut write,
                    &mut seq,
                    AgentToServer::Status {
                        state: "playing".into(),
                        game_id: Some(game_id),
                    },
                )
                .await?;

                // CLI options first, then per-game overrides from the web.
                let mut options = opts.uci_options.clone();
                options.extend(uci_options);

                // A failed game must never tear down the control session —
                // log it and report idle so the next assignment still works.
                if let Err(e) = play(PlayOpts {
                    server: ws_base_url.to_string(),
                    game_id: game_id.to_string(),
                    token,
                    engine_path: opts.engine_path.clone(),
                    engine_args: opts.engine_args.clone(),
                    book: book.clone(),
                    uci_options: options,
                })
                .await
                {
                    eprintln!("game ended with error: {e:#}");
                }
                send_agent(
                    &mut write,
                    &mut seq,
                    AgentToServer::Status {
                        state: "idle".into(),
                        game_id: None,
                    },
                )
                .await?;
                println!("ready for the next game (drive it from the website)");
            }
            ServerToAgent::Error { code, message } => {
                eprintln!("server: [{code}] {message}");
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Autopilot mode (--auto): unattended matchmaking over park offers
// ---------------------------------------------------------------------------

/// A challenge we posted and may need to withdraw (offer_id, cancel_key).
type PostedOffer = Arc<Mutex<Option<(String, String)>>>;

async fn run_autopilot(
    client: &reqwest::Client,
    http: &str,
    opts: &ConnectOpts,
    session: Session,
    engine_name: &str,
    book: Option<Arc<OpeningBook>>,
) -> Result<()> {
    // Owned + mutable: the server keeps sessions in memory, so a restart there
    // voids ours mid-run and we re-authenticate in place rather than dying.
    let mut session = session;
    let ws = ws_base(http);
    if opts.stake.is_some() {
        println!(
            "autopilot: staked games at {} base units",
            opts.stake.as_deref().unwrap()
        );
    }

    // On Ctrl-C OR SIGTERM (service managers stop with TERM): withdraw any
    // posted challenge so the lobby doesn't show a ghost offer for the next
    // hour, then exit. A lingering offer isn't just cosmetic — a restarted
    // same-wallet autopilot could otherwise accept its own stale offer.
    let posted: PostedOffer = Arc::new(Mutex::new(None));
    {
        let posted = posted.clone();
        let client = client.clone();
        let http = http.to_string();
        tokio::spawn(async move {
            wait_for_shutdown_signal().await;
            let open = posted.lock().unwrap().take();
            if let Some((id, key)) = open {
                let _ = client
                    .delete(format!("{http}/park/offers/{id}?key={key}"))
                    .send()
                    .await;
                eprintln!("\nwithdrew open challenge");
            }
            std::process::exit(130);
        });
    }

    let mut played = 0u32;
    let mut backoff = 5u64;
    loop {
        if opts.games > 0 && played >= opts.games {
            break;
        }

        // Transient server/network errors must not kill the autopilot (an
        // exit strands the posted offer for its 1h TTL) — log and retry.
        let attempt =
            match find_and_accept(client, http, opts, &session, engine_name, &posted).await {
                Ok(Some(seat)) => Ok(Some(seat)),
                Ok(None) => post_and_wait(client, http, opts, &session, engine_name, &posted).await,
                Err(e) => Err(e),
            };
        let seat = match attempt {
            Ok(seat) => seat,
            // A 401 means our session is gone (the server holds them in
            // memory, so its restart voids ours). Retrying the same dead token
            // would spin forever, so mint a new one and rescan. Without this
            // the server's strict-auth rejection would just stall the bot.
            Err(e) if is_unauthorized(&e) => {
                eprintln!("session rejected; re-authenticating…");
                match sign_in(client, http, opts).await {
                    Ok(s) => {
                        println!("signed in as {}", s.address);
                        session = s;
                    }
                    // Can't re-auth (a --code is single-use, so this is
                    // terminal for that flow) — back off and let the loop or
                    // the supervisor decide.
                    Err(e) => {
                        eprintln!("re-authentication failed: {e:#}; retrying in {backoff}s");
                        tokio::time::sleep(Duration::from_secs(backoff)).await;
                        backoff = (backoff * 2).min(60);
                    }
                }
                continue;
            }
            Err(e) => {
                eprintln!("matchmaking error: {e:#}; retrying in {backoff}s");
                tokio::time::sleep(Duration::from_secs(backoff)).await;
                backoff = (backoff * 2).min(60);
                continue;
            }
        };
        backoff = 5;
        let Some((game_id, token, color)) = seat else {
            continue; // lost a race; rescan
        };

        println!("game {}: playing {color} in {game_id}", played + 1);
        if let Err(e) = play(PlayOpts {
            server: ws.clone(),
            game_id,
            token,
            engine_path: opts.engine_path.clone(),
            engine_args: opts.engine_args.clone(),
            book: book.clone(),
            uci_options: opts.uci_options.clone(),
        })
        .await
        {
            eprintln!("game ended with error: {e:#}");
        }
        played += 1;
    }
    println!("autopilot finished after {played} game(s)");
    Ok(())
}

/// Resolve on Ctrl-C (SIGINT) or, on unix, SIGTERM — what service managers
/// send on stop. Windows only has Ctrl-C.
async fn wait_for_shutdown_signal() {
    #[cfg(unix)]
    {
        let mut term =
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(s) => s,
                Err(_) => return tokio::signal::ctrl_c().await.unwrap_or(()),
            };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

fn auth_rb(rb: reqwest::RequestBuilder, session: &Session) -> reqwest::RequestBuilder {
    rb.bearer_auth(&session.token)
}

/// An open offer is compatible when its stake and time control match ours and
/// it wasn't posted by us.
fn compatible(o: &Value, opts: &ConnectOpts, my_addr: &str, my_offer: Option<&str>) -> bool {
    let stake_matches = match (&opts.stake, o["stake"].as_str()) {
        (None, None) => true,
        (Some(want), Some(have)) => want == have,
        _ => false,
    };
    let tc_matches = o["initial_secs"].as_u64() == Some(opts.initial_secs)
        && o["increment_secs"].as_u64() == Some(opts.increment_secs);
    // The wallet check only helps when the server publishes a poster: it is
    // null on casual offers, where this deliberately fails OPEN so an
    // unauthenticated poster is still matchable.
    let not_my_wallet = match o["poster_addr"].as_str() {
        Some(poster) => !poster.eq_ignore_ascii_case(my_addr),
        None => true,
    };
    // ...which is why the offer id is the check that actually stops us taking
    // our OWN challenge. Failing open above meant an autopilot re-scanning
    // after a game found the offer it had just posted, joined it, and got the
    // game rejected for same-wallet seats — then reposted, forever. The park
    // looked empty because the bot kept eating its own challenge.
    let not_my_own_post = match (my_offer, o["offer_id"].as_str()) {
        (Some(mine), Some(id)) => mine != id,
        _ => true,
    };
    stake_matches && tc_matches && not_my_wallet && not_my_own_post
}

/// Scan the park for a compatible open challenge and try to take it. Returns
/// the seat on success, None when there's nothing to take (or we lost a race).
async fn find_and_accept(
    client: &reqwest::Client,
    http: &str,
    opts: &ConnectOpts,
    session: &Session,
    engine_name: &str,
    posted: &PostedOffer,
) -> Result<Option<(String, String, &'static str)>> {
    let offers: Vec<Value> = client
        .get(format!("{http}/park/offers"))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    // Snapshot (don't hold the lock across the scan) the challenge we still
    // have standing, so we never take our own.
    let my_offer = posted.lock().unwrap().as_ref().map(|(id, _)| id.clone());
    let Some(offer) = offers
        .iter()
        .find(|o| compatible(o, opts, &session.address, my_offer.as_deref()))
    else {
        return Ok(None);
    };
    let id = offer["offer_id"].as_str().unwrap_or_default();
    let poster = offer["poster_name"]
        .as_str()
        .or(offer["poster_addr"].as_str())
        .unwrap_or("anonymous");
    println!("found open challenge from {poster}, joining…");
    accept_offer(client, http, id, opts, session, engine_name).await
}

async fn accept_offer(
    client: &reqwest::Client,
    http: &str,
    offer_id: &str,
    opts: &ConnectOpts,
    session: &Session,
    engine_name: &str,
) -> Result<Option<(String, String, &'static str)>> {
    let resp = auth_rb(
        client.post(format!("{http}/park/offers/{offer_id}/accept")),
        session,
    )
    .json(&json!({ "name": opts.name, "engine": engine_name }))
    .send()
    .await?;
    if !resp.status().is_success() {
        // Someone else took it (409/404) or we can't afford it — rescan.
        return Ok(None);
    }
    let j: Value = resp.json().await?;
    match (j["game_id"].as_str(), j["token"].as_str()) {
        (Some(g), Some(t)) => Ok(Some((g.to_string(), t.to_string(), "black"))),
        _ => Err(anyhow!("malformed accept response")),
    }
}

/// Post our own challenge and wait for a taker, while keeping an eye on the
/// park: if a compatible foreign challenge appears, withdraw ours and take
/// theirs instead (prevents two waiting engines from ignoring each other).
async fn post_and_wait(
    client: &reqwest::Client,
    http: &str,
    opts: &ConnectOpts,
    session: &Session,
    engine_name: &str,
    posted: &PostedOffer,
) -> Result<Option<(String, String, &'static str)>> {
    let resp: Value = auth_rb(client.post(format!("{http}/park/offers")), session)
        .json(&json!({
            "stake": opts.stake,
            "initial_secs": opts.initial_secs,
            "increment_secs": opts.increment_secs,
            "name": opts.name,
            "engine": engine_name,
        }))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let offer_id = resp["offer_id"]
        .as_str()
        .ok_or_else(|| anyhow!("no offer_id"))?
        .to_string();
    let cancel_key = resp["cancel_key"].as_str().unwrap_or_default().to_string();
    *posted.lock().unwrap() = Some((offer_id.clone(), cancel_key.clone()));
    println!("challenge posted, waiting for an opponent… (Ctrl-C to withdraw)");

    let mut ticks = 0u32;
    loop {
        // Poll fast while a match is likely imminent, then back off to 10s —
        // a 24/7 house bot otherwise hammers the single-node server with
        // "still waiting" requests all night.
        let interval = if ticks < 30 { 2 } else { 10 };
        tokio::time::sleep(Duration::from_secs(interval)).await;
        ticks += 1;

        // Did someone take our challenge?
        let o: Value = auth_rb(
            client.get(format!("{http}/park/offers/{offer_id}")),
            session,
        )
        .send()
        .await?
        .json()
        .await?;
        match o["status"].as_str() {
            Some("matched") => {
                *posted.lock().unwrap() = None;
                let (Some(g), Some(t)) = (o["game_id"].as_str(), o["token"].as_str()) else {
                    return Err(anyhow!("matched but no token"));
                };
                println!("challenge accepted!");
                return Ok(Some((g.to_string(), t.to_string(), "white")));
            }
            Some("not_found") => {
                // Expired (TTL sweep) — repost on the next loop.
                *posted.lock().unwrap() = None;
                return Ok(None);
            }
            _ => {}
        }

        // Every ~6s, look for a foreign challenge we could take instead.
        if ticks % 3 != 0 {
            continue;
        }
        let offers: Vec<Value> = match client.get(format!("{http}/park/offers")).send().await {
            Ok(r) => r.json().await.unwrap_or_default(),
            Err(_) => continue,
        };
        // `compatible` now owns the "not our own challenge" check, so the id
        // guard that used to live here isn't duplicated.
        let foreign = offers
            .iter()
            .find(|c| compatible(c, opts, &session.address, Some(offer_id.as_str())));
        let Some(foreign) = foreign else { continue };

        // Withdraw ours first so we never hold two boards at once. A 409 means
        // ours matched in the race — loop back and pick up our own game.
        let del = client
            .delete(format!("{http}/park/offers/{offer_id}?key={cancel_key}"))
            .send()
            .await?;
        if del.status() == reqwest::StatusCode::CONFLICT {
            continue;
        }
        *posted.lock().unwrap() = None;
        let foreign_id = foreign["offer_id"].as_str().unwrap_or_default().to_string();
        println!("switching to a newly posted challenge…");
        return accept_offer(client, http, &foreign_id, opts, session, engine_name).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn opts() -> ConnectOpts {
        ConnectOpts {
            http_server: "http://localhost:8080".into(),
            name: None,
            engine_path: "stockfish".into(),
            engine_args: vec![],
            book_path: None,
            book_max_ply: 0,
            uci_options: vec![],
            auth_token: None,
            code: None,
            auto: true,
            stake: None,
            initial_secs: 180,
            increment_secs: 0,
            games: 0,
        }
    }

    /// A casual offer carries no `poster_addr` — the shape the house bot posts,
    /// and the reason the wallet check alone can't tell ours from a stranger's.
    fn casual_offer(id: &str) -> Value {
        json!({
            "offer_id": id,
            "poster_addr": Value::Null,
            "poster_name": "House Bot",
            "stake": Value::Null,
            "initial_secs": 180,
            "increment_secs": 0,
        })
    }

    #[test]
    fn does_not_take_its_own_casual_challenge() {
        // Regression: the autopilot re-scans the park after each game. It used
        // to find the challenge it had just posted (poster_addr null → the
        // wallet check fails open), join it, and have the game rejected for
        // same-wallet seats — then repost, forever, leaving the park empty.
        assert!(!compatible(
            &casual_offer("mine"),
            &opts(),
            "0xabc",
            Some("mine")
        ));
    }

    #[test]
    fn still_takes_a_strangers_casual_challenge() {
        // Negative control: the id guard must not make casual offers
        // unmatchable, or the autopilot would never pair with a real visitor.
        assert!(compatible(
            &casual_offer("theirs"),
            &opts(),
            "0xabc",
            Some("mine")
        ));
    }

    #[test]
    fn still_skips_a_foreign_offer_at_another_time_control() {
        let mut o = casual_offer("theirs");
        o["initial_secs"] = json!(600);
        assert!(!compatible(&o, &opts(), "0xabc", Some("mine")));
    }

    #[test]
    fn skips_our_own_wallet_when_the_server_does_publish_it() {
        // The wallet check still earns its keep on authed/staked offers.
        let mut o = casual_offer("theirs");
        o["poster_addr"] = json!("0xABC");
        assert!(!compatible(&o, &opts(), "0xabc", Some("mine")));
    }
}
