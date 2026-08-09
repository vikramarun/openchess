//! Best-effort out-of-band alerting for money-critical failures.
//!
//! When `ALERT_WEBHOOK_URL` is set, [`fire`] POSTs a short JSON message to it —
//! fire-and-forget, on a detached task, with a timeout, so it never blocks or
//! panics the caller. Unset ⇒ no-op; the `tracing::error!` at every call site
//! remains the record of truth. The body carries both `text` (Slack, and
//! Telegram's sendMessage with the chat encoded in the URL's query string) and
//! `content` (Discord) keys so the common webhooks work without extra config.
//!
//! This exists because the two loudest failure logs — an escrow refund failing
//! after an aborted dispatch, and the settlement outbox giving up — mean funds
//! are stuck, and until now nobody would notice. See HANDOFF.md.

/// Strip anything that looks like a URL from alert text.
///
/// Settlement failure alerts interpolate raw provider error chains (`{e:#}` /
/// `{msg}`), and an alloy/reqwest error's `Display` includes the request URL —
/// which for a keyed RPC endpoint (Alchemy/Infura style) carries the API key in
/// its path. The alert destination is operator-configured but third-party
/// (Slack/Discord/Telegram) and may be logged or indexed there, so scrub URLs
/// before the message leaves the process. Not the oracle key (that never reaches
/// an error string), but no secret should ride an alert out unnecessarily.
fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    loop {
        // Earliest scheme wins ("http://" is not a substring of "https://", so
        // the two never overlap). `find` yields a char-boundary byte index.
        let next = ["https://", "http://"]
            .iter()
            .filter_map(|s| rest.find(s))
            .min();
        match next {
            Some(idx) => {
                out.push_str(&rest[..idx]);
                out.push_str("[redacted-url]");
                let after = &rest[idx..];
                let end = after.find(char::is_whitespace).unwrap_or(after.len());
                rest = &after[end..];
            }
            None => {
                out.push_str(rest);
                break;
            }
        }
    }
    out
}

/// Send an alert if a webhook is configured. Safe to call from any async
/// context on the tokio runtime; returns immediately.
pub fn fire(text: impl Into<String>) {
    let Ok(url) = std::env::var("ALERT_WEBHOOK_URL") else {
        return;
    };
    if url.trim().is_empty() {
        return;
    }
    let text = redact(&text.into());
    tokio::spawn(async move {
        let body = serde_json::json!({ "text": text, "content": text });
        let res = reqwest::Client::new()
            .post(&url)
            .timeout(std::time::Duration::from_secs(5))
            .json(&body)
            .send()
            .await;
        // Both halves matter. A transport error is a network problem; a non-2xx
        // is the webhook REFUSING the message (a Telegram bot kicked from its
        // group answers 403, Slack a revoked hook 404) — and swallowing that
        // turns the stuck-funds alarm into a silent no-op, the exact failure
        // mode this module exists to prevent.
        match res {
            // `without_url()` strips the URL from the error: the webhook URL's
            // path IS a secret (Slack/Discord/Telegram tokens), so it must not
            // hit logs.
            Err(e) => tracing::warn!("alert webhook POST failed: {}", e.without_url()),
            Ok(r) if !r.status().is_success() => {
                // Status only — the response body can echo request details.
                tracing::warn!("alert webhook rejected the message: HTTP {}", r.status());
            }
            Ok(_) => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::redact;

    #[test]
    fn redact_strips_keyed_rpc_urls_but_keeps_the_message() {
        let msg = "settlement failed: error sending request for url \
                   (https://base-mainnet.g.alchemy.com/v2/SECRETKEY123): timeout";
        let out = redact(msg);
        assert!(!out.contains("SECRETKEY123"), "API key survived: {out}");
        assert!(!out.contains("alchemy.com"), "host survived: {out}");
        assert!(out.contains("settlement failed"));
        assert!(
            out.contains("timeout"),
            "text after the url was dropped: {out}"
        );
        assert!(out.contains("[redacted-url]"));
    }

    #[test]
    fn redact_handles_multiple_urls_and_no_url() {
        let out = redact("a http://x.io/1 b https://y.io/2 c");
        assert_eq!(out, "a [redacted-url] b [redacted-url] c");
        assert_eq!(redact("no urls here"), "no urls here");
        // A URL at the very end (no trailing whitespace) is still scrubbed whole.
        assert_eq!(redact("see https://z.io/p?k=1"), "see [redacted-url]");
    }
}
