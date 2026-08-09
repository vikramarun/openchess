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

/// Send an alert if a webhook is configured. Safe to call from any async
/// context on the tokio runtime; returns immediately.
pub fn fire(text: impl Into<String>) {
    let Ok(url) = std::env::var("ALERT_WEBHOOK_URL") else {
        return;
    };
    if url.trim().is_empty() {
        return;
    }
    let text = text.into();
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
