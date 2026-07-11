//! Session auth for the native client.
//!
//! Three ways to get a SIWE session token (needed only for wagered play):
//! 1. `--auth-token` — paste an existing session token.
//! 2. `--link-code` — claim a single-use code minted in the web app
//!    ("Connect your engine" page) while signed in. No key ever leaves the
//!    browser wallet.
//! 3. `OPENCHESS_WALLET_KEY` env var — sign SIWE locally with a raw private
//!    key (headless bots). Env-only on purpose: a key must never appear in a
//!    shell history or process list.

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};

/// An authenticated session against the game server.
#[derive(Clone, Debug)]
pub struct Session {
    pub token: String,
    pub address: String,
}

/// Resolve a session from the configured sources (see module docs). Returns
/// `None` when no credential is supplied — fine for casual play.
pub async fn resolve_session(
    client: &reqwest::Client,
    http: &str,
    auth_token: Option<String>,
    link_code: Option<String>,
) -> Result<Option<Session>> {
    if let Some(token) = auth_token {
        // Validate the pasted token and learn our address.
        let me: Value = client
            .get(format!("{http}/auth/me"))
            .bearer_auth(&token)
            .send()
            .await?
            .error_for_status()
            .context("session token rejected by /auth/me")?
            .json()
            .await?;
        let address = me["address"]
            .as_str()
            .ok_or_else(|| anyhow!("no address in /auth/me"))?
            .to_string();
        return Ok(Some(Session { token, address }));
    }

    if let Some(code) = link_code {
        let resp: Value = client
            .post(format!("{http}/auth/link/claim"))
            .json(&json!({ "code": code }))
            .send()
            .await?
            .error_for_status()
            .context("link code rejected (expired or already used?)")?
            .json()
            .await?;
        return Ok(Some(session_from_verify(&resp)?));
    }

    if let Ok(key) = std::env::var("OPENCHESS_WALLET_KEY") {
        let s = siwe_login(client, http, key.trim()).await?;
        return Ok(Some(s));
    }

    Ok(None)
}

/// Full SIWE round-trip: fetch server config + nonce, build an EIP-4361
/// message bound to the server's domain/chain, personal_sign it with the
/// supplied key, and exchange it for a session token.
async fn siwe_login(client: &reqwest::Client, http: &str, key: &str) -> Result<Session> {
    let config: Value = client
        .get(format!("{http}/config"))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let domain = config["siwe_domain"]
        .as_str()
        .ok_or_else(|| anyhow!("server /config has no siwe_domain (older server?)"))?
        .to_string();
    let chain_id = config["chain_id"].as_u64().unwrap_or(8453);

    let nonce: Value = client
        .get(format!("{http}/auth/nonce"))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let nonce = nonce["nonce"]
        .as_str()
        .ok_or_else(|| anyhow!("no nonce"))?
        .to_string();

    // The message must embed the signer's address, so derive it first.
    let (address, _) = ledger::personal_sign(key, "probe")?;
    let message = build_siwe_message(&domain, &format!("{address:?}"), chain_id, &nonce);
    let (_, signature) = ledger::personal_sign(key, &message)?;

    let resp: Value = client
        .post(format!("{http}/auth/verify"))
        .json(&json!({ "message": message, "signature": signature }))
        .send()
        .await?
        .error_for_status()
        .context("SIWE verify failed (check SIWE_DOMAIN/chain)")?
        .json()
        .await?;
    session_from_verify(&resp)
}

fn session_from_verify(resp: &Value) -> Result<Session> {
    Ok(Session {
        token: resp["token"]
            .as_str()
            .ok_or_else(|| anyhow!("no token in auth response"))?
            .to_string(),
        address: resp["address"]
            .as_str()
            .ok_or_else(|| anyhow!("no address in auth response"))?
            .to_string(),
    })
}

/// Build an EIP-4361 message in the exact shape the server verifies: domain on
/// line 1, address on line 2, and the labelled fields in the `URI:` block.
pub fn build_siwe_message(domain: &str, address: &str, chain_id: u64, nonce: &str) -> String {
    let issued_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    format!(
        "{domain} wants you to sign in with your Ethereum account:\n\
         {address}\n\
         \n\
         OpenChess BYO engine client\n\
         \n\
         URI: https://{domain}\n\
         Version: 1\n\
         Chain ID: {chain_id}\n\
         Nonce: {nonce}\n\
         Issued At: {issued_at}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // A well-known anvil test key — NOT a secret.
    const TEST_KEY: &str = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    const TEST_ADDR: &str = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

    #[test]
    fn siwe_message_signs_and_recovers() {
        let (addr, _) = ledger::personal_sign(TEST_KEY, "probe").unwrap();
        let msg = build_siwe_message("openchess.ai", &format!("{addr:?}"), 8453, "n0nce");
        let (_, sig) = ledger::personal_sign(TEST_KEY, &msg).unwrap();
        let recovered = ledger::recover_personal_sign(&msg, &sig).expect("recover");
        assert_eq!(format!("{recovered:?}").to_lowercase(), TEST_ADDR);
        // Shape the server's parser expects.
        assert!(msg.starts_with("openchess.ai wants you to sign in"));
        assert!(msg.contains("\nChain ID: 8453\n"));
        assert!(msg.contains("\nNonce: n0nce\n"));
    }
}
