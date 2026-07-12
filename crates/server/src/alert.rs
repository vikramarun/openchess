//! Best-effort out-of-band alerting for money-critical failures.
//!
//! When `ALERT_WEBHOOK_URL` is set, [`fire`] POSTs a short JSON message to it —
//! fire-and-forget, on a detached task, with a timeout, so it never blocks or
//! panics the caller. Unset ⇒ no-op; the `tracing::error!` at every call site
//! remains the record of truth. The body carries both `text` (Slack) and
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
        if let Err(e) = res {
            // `without_url()` strips the URL from the error: the webhook URL's
            // path IS a secret (Slack/Discord tokens), so it must not hit logs.
            tracing::warn!("alert webhook POST failed: {}", e.without_url());
        }
    });
}
