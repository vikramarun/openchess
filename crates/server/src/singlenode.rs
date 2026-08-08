//! Detect the one misconfiguration this server cannot survive: a second
//! machine.
//!
//! Every piece of live state — lobby, rooms, launch tokens, SIWE nonces and
//! sessions, rate-limit buckets — lives in ONE process's memory. With two
//! machines behind the proxy, requests alternate between them: a nonce issued
//! by A fails to verify on B (intermittent sign-in 401s that read exactly like
//! a client bug), and park offers appear and vanish depending on which machine
//! answered. This happened in production and cost a long debugging session,
//! because nothing anywhere said "there are two of you".
//!
//! `scripts/deploy-server.sh` asserts the machine count, but it can only police
//! the deploys that go through it — a bare `fly deploy` re-adds the HA machine
//! and never touches the wrapper. This is the backstop that doesn't depend on
//! anyone remembering.
//!
//! **Detection needs no credential.** Fly publishes one AAAA record per running
//! machine at `<app>.internal`, so a plain DNS lookup counts our siblings. No
//! API token to provision, rotate, or leak.
//!
//! **Deliberately not fail-closed.** Refusing to serve would be worse than the
//! condition: a platform-wide restart would have every machine see its peers
//! and take the whole site down, and a transient DNS answer could do the same.
//! The harm from two machines is degradation, not fund loss (money paths fail
//! closed on their own), so this logs loudly and pages instead.

use std::collections::HashSet;
use std::net::IpAddr;
use std::time::{Duration, Instant};

/// How often to look for siblings.
const CHECK_INTERVAL: Duration = Duration::from_secs(60);

/// Consecutive positive checks before alerting. A rolling deploy can show two
/// machines for a moment while one replaces the other; that is normal and must
/// not page anyone.
const CONSECUTIVE_BEFORE_ALERT: u32 = 3;

/// Minimum gap between pages while the condition persists, so a split that
/// goes unfixed overnight doesn't bury the channel it's reported in.
const REALERT_AFTER: Duration = Duration::from_secs(60 * 60);

/// How many machines are currently serving this app?
///
/// `None` when we can't tell — not running on Fly (no `FLY_APP_NAME`), or the
/// lookup failed. An unknown count is never treated as a problem: this is a
/// diagnostic, and guessing would page on every DNS hiccup.
pub async fn peer_count() -> Option<usize> {
    let app = std::env::var("FLY_APP_NAME").ok()?;
    count_for_host(&format!("{app}.internal")).await
}

/// Resolve `host` and count the distinct addresses behind it.
async fn count_for_host(host: &str) -> Option<usize> {
    // Port is irrelevant to the record count; `lookup_host` just wants one.
    let addrs = tokio::net::lookup_host(format!("{host}:80")).await.ok()?;
    let unique: HashSet<IpAddr> = addrs.map(|s| s.ip()).collect();
    Some(unique.len())
}

/// Watch for a second machine for the life of the process. Spawned under
/// `supervise`, so it must never return on the happy path.
pub async fn watch() {
    if std::env::var("FLY_APP_NAME").is_err() {
        tracing::debug!("single-node watch: not on Fly, skipping");
        // Park rather than return: `supervise` restarts a worker that exits,
        // which would spin for the whole life of a local dev process.
        std::future::pending::<()>().await;
        return;
    }

    let mut consecutive: u32 = 0;
    let mut last_alert: Option<Instant> = None;

    loop {
        // Sleep first: at boot a rolling deploy may still be swapping machines,
        // and the interesting case (someone adds a machine later) is not
        // time-critical to within one interval.
        tokio::time::sleep(CHECK_INTERVAL).await;

        let Some(n) = peer_count().await else {
            continue;
        };

        if n <= 1 {
            consecutive = 0;
            continue;
        }

        consecutive += 1;
        if consecutive < CONSECUTIVE_BEFORE_ALERT {
            tracing::warn!(
                machines = n,
                "more than one machine is serving this app; confirming before alerting \
                 ({consecutive}/{CONSECUTIVE_BEFORE_ALERT})"
            );
            continue;
        }

        tracing::error!(
            machines = n,
            "SPLIT BRAIN: {n} machines are serving this single-node app. Lobby, rooms, \
             launch tokens and SIWE sessions are per-process, so sign-in and matchmaking \
             will fail intermittently. Fix with: fly scale count 1"
        );
        if last_alert.is_none_or(|t| t.elapsed() >= REALERT_AFTER) {
            crate::alert::fire(format!(
                "OpenChess: {n} machines are serving a single-node app — sign-in and the \
                 lobby will fail intermittently. Run `fly scale count 1`."
            ));
            last_alert = Some(Instant::now());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_host_with_one_address_counts_one() {
        // localhost may resolve to both 127.0.0.1 and ::1, so assert on a
        // literal: it must count exactly the distinct addresses it is given.
        assert_eq!(count_for_host("127.0.0.1").await, Some(1));
    }

    #[tokio::test]
    async fn an_unresolvable_host_is_unknown_not_a_split() {
        // The distinction that matters: a failed lookup must read as "can't
        // tell" so a DNS hiccup never pages. `None` is filtered out by
        // `watch`; `Some(2)` would page.
        let n = count_for_host("openchess-nonexistent.invalid").await;
        assert_eq!(n, None);
    }

    #[tokio::test]
    async fn peer_count_is_none_off_fly() {
        // No FLY_APP_NAME (local dev, or any non-Fly host) ⇒ nothing to watch.
        if std::env::var("FLY_APP_NAME").is_err() {
            assert_eq!(peer_count().await, None);
        }
    }
}
