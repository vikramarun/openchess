//! In-process rate limiting + connection caps.
//!
//! Single-node only, like the rest of this server's live state — a multi-node
//! deployment would move these behind Redis (see HANDOFF.md). Two primitives,
//! both keyed by a string (typically a client IP, sometimes a wallet):
//!
//! - [`TokenBucket`] — request-rate limiting. Each check costs one token;
//!   tokens refill at a fixed rate, so short bursts are absorbed but a sustained
//!   flood is throttled. `check` returns the retry-after hint when over budget.
//! - [`ConnGate`] — concurrent-connection caps (a global ceiling plus a per-key
//!   ceiling) for the WebSocket routes, handing back an RAII guard that releases
//!   the slot on drop (so every connection teardown path frees it).
//!
//! All limits are tunable via env vars (see [`RateLimits::from_env`]) so they
//! can be tightened in production without a redeploy of new defaults.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::http::HeaderMap;
use parking_lot::Mutex;

/// A per-key token bucket: `capacity` tokens, refilled at `refill_per_sec`.
pub struct TokenBucket {
    capacity: f64,
    refill_per_sec: f64,
    buckets: Mutex<HashMap<String, Bucket>>,
}

struct Bucket {
    tokens: f64,
    last: Instant,
}

impl TokenBucket {
    pub fn new(capacity: u32, refill_per_sec: f64) -> Self {
        Self {
            capacity: capacity.max(1) as f64,
            refill_per_sec: refill_per_sec.max(0.0),
            buckets: Mutex::new(HashMap::new()),
        }
    }

    /// Consume one token for `key`. Returns `None` when allowed, or
    /// `Some(retry_after)` — an estimate of how long until a token frees up —
    /// when the caller is over budget.
    pub fn check(&self, key: &str) -> Option<Duration> {
        let now = Instant::now();
        let mut buckets = self.buckets.lock();
        let b = buckets.entry(key.to_owned()).or_insert(Bucket {
            tokens: self.capacity,
            last: now,
        });
        // Refill for the time elapsed since we last touched this bucket.
        let elapsed = now.saturating_duration_since(b.last).as_secs_f64();
        b.tokens = (b.tokens + elapsed * self.refill_per_sec).min(self.capacity);
        b.last = now;
        if b.tokens >= 1.0 {
            b.tokens -= 1.0;
            None
        } else if self.refill_per_sec > 0.0 {
            let secs = ((1.0 - b.tokens) / self.refill_per_sec).min(3600.0);
            Some(Duration::from_secs_f64(secs))
        } else {
            // Never refills (refill disabled) — cap the hint at an hour.
            Some(Duration::from_secs(3600))
        }
    }

    /// Drop buckets that have fully refilled back to `capacity` (idle keys), to
    /// bound memory. Called from the periodic sweep task.
    pub fn sweep(&self) {
        let now = Instant::now();
        self.buckets.lock().retain(|_, b| {
            let elapsed = now.saturating_duration_since(b.last).as_secs_f64();
            let tokens = (b.tokens + elapsed * self.refill_per_sec).min(self.capacity);
            // Keep only buckets still "in debt" (would-be-throttled callers).
            tokens < self.capacity
        });
    }
}

/// Concurrent-connection caps: a global ceiling plus a per-key ceiling. Callers
/// [`acquire`](ConnGate::acquire) a slot and hold the returned [`ConnGuard`] for
/// the connection's lifetime; dropping the guard (any exit path) frees the slot.
pub struct ConnGate {
    global_max: usize,
    per_key_max: usize,
    inner: Arc<Mutex<ConnCounts>>,
}

#[derive(Default)]
struct ConnCounts {
    total: usize,
    per_key: HashMap<String, usize>,
}

/// RAII slot held for the lifetime of a connection; releases on drop.
pub struct ConnGuard {
    key: String,
    inner: Arc<Mutex<ConnCounts>>,
}

impl ConnGate {
    pub fn new(global_max: usize, per_key_max: usize) -> Self {
        Self {
            global_max: global_max.max(1),
            per_key_max: per_key_max.max(1),
            inner: Arc::new(Mutex::new(ConnCounts::default())),
        }
    }

    /// Try to take a slot for `key`. Returns `None` if the global or the
    /// per-key ceiling is already reached.
    pub fn acquire(&self, key: &str) -> Option<ConnGuard> {
        let mut guard = self.inner.lock();
        let c = &mut *guard;
        if c.total >= self.global_max {
            return None;
        }
        let n = c.per_key.entry(key.to_owned()).or_insert(0);
        if *n >= self.per_key_max {
            return None;
        }
        *n += 1;
        c.total += 1;
        Some(ConnGuard {
            key: key.to_owned(),
            inner: self.inner.clone(),
        })
    }
}

impl Drop for ConnGuard {
    fn drop(&mut self) {
        let mut c = self.inner.lock();
        c.total = c.total.saturating_sub(1);
        if let Some(n) = c.per_key.get_mut(&self.key) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                c.per_key.remove(&self.key);
            }
        }
    }
}

/// The server's rate-limit configuration: one bundle held in `AppState`.
pub struct RateLimits {
    /// `/auth/*` — SIWE nonce/verify + link codes (signature recovery is not free).
    pub auth: TokenBucket,
    /// Park offer create/accept.
    pub offers: TokenBucket,
    /// WebSocket upgrade churn (both `/ws/game` and `/ws/agent`).
    pub ws: TokenBucket,
    /// Concurrent `/ws/agent` (bot control) sockets.
    pub agent_conns: ConnGate,
    /// Concurrent `/ws/game` (player + spectator) sockets.
    pub game_conns: ConnGate,
    /// Max simultaneously-open park offers a single owner (wallet, or IP for
    /// anonymous casual offers) may hold.
    pub max_open_offers: usize,
}

impl RateLimits {
    /// Build from env vars, falling back to conservative defaults. All are safe
    /// to leave unset; production can tighten any of them without a code change.
    pub fn from_env() -> Self {
        Self {
            auth: TokenBucket::new(env_u32("RL_AUTH_BURST", 20), env_f64("RL_AUTH_PER_SEC", 1.0)),
            offers: TokenBucket::new(
                env_u32("RL_OFFERS_BURST", 10),
                env_f64("RL_OFFERS_PER_SEC", 0.5),
            ),
            ws: TokenBucket::new(env_u32("RL_WS_BURST", 30), env_f64("RL_WS_PER_SEC", 1.0)),
            agent_conns: ConnGate::new(
                env_usize("RL_AGENT_CONNS_MAX", 512),
                env_usize("RL_AGENT_CONNS_PER_IP", 8),
            ),
            game_conns: ConnGate::new(
                env_usize("RL_GAME_CONNS_MAX", 2048),
                env_usize("RL_GAME_CONNS_PER_IP", 32),
            ),
            // Comfortably above the house bot's one-open-offer-per-time-control
            // (scripts/house-bot.sh defaults to 4 TCs under one wallet); bump
            // RL_MAX_OPEN_OFFERS if you run more house time controls.
            max_open_offers: env_usize("RL_MAX_OPEN_OFFERS", 8),
        }
    }

    /// Prune idle buckets (called from the periodic sweep task).
    pub fn sweep(&self) {
        self.auth.sweep();
        self.offers.sweep();
        self.ws.sweep();
    }
}

impl Default for RateLimits {
    fn default() -> Self {
        Self::from_env()
    }
}

/// Best-effort client IP for rate-limit keying. Behind Fly the trustworthy
/// value is `Fly-Client-IP` (stamped by the proxy — a client can't forge it
/// end-to-end); `X-Real-IP` / the first `X-Forwarded-For` hop cover other
/// proxies. Falls back to a single shared key when unknown (local dev), which
/// is harmless — dev traffic is trusted and the caps are generous.
pub fn client_ip(headers: &HeaderMap) -> String {
    for h in ["fly-client-ip", "x-real-ip"] {
        if let Some(v) = headers.get(h).and_then(|v| v.to_str().ok()) {
            let v = v.trim();
            if !v.is_empty() {
                return v.to_string();
            }
        }
    }
    if let Some(first) = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return first.to_string();
    }
    "unknown".to_string()
}

fn env_u32(key: &str, default: u32) -> u32 {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}
fn env_usize(key: &str, default: usize) -> usize {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}
fn env_f64(key: &str, default: f64) -> f64 {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_bucket_allows_burst_then_throttles() {
        // 3 tokens, no refill within the test window.
        let tb = TokenBucket::new(3, 0.0);
        assert!(tb.check("ip").is_none());
        assert!(tb.check("ip").is_none());
        assert!(tb.check("ip").is_none());
        // 4th request over the burst is throttled.
        assert!(tb.check("ip").is_some());
    }

    #[test]
    fn token_bucket_is_per_key() {
        let tb = TokenBucket::new(1, 0.0);
        assert!(tb.check("a").is_none());
        assert!(tb.check("a").is_some()); // a is spent…
        assert!(tb.check("b").is_none()); // …but b has its own budget.
    }

    #[test]
    fn token_bucket_refills_over_time() {
        // 1 token, refills 1000/s → a ~5ms sleep restores well over one token.
        let tb = TokenBucket::new(1, 1000.0);
        assert!(tb.check("ip").is_none());
        assert!(tb.check("ip").is_some());
        std::thread::sleep(Duration::from_millis(5));
        assert!(tb.check("ip").is_none(), "should have refilled after sleep");
    }

    #[test]
    fn token_bucket_sweep_drops_idle_keys() {
        let tb = TokenBucket::new(2, 1000.0);
        assert!(tb.check("ip").is_none()); // spend one; bucket now below capacity
        std::thread::sleep(Duration::from_millis(5)); // refills back to full
        tb.sweep();
        assert_eq!(tb.buckets.lock().len(), 0, "fully-refilled key is pruned");
    }

    #[test]
    fn conn_gate_enforces_per_key_and_global() {
        let gate = ConnGate::new(3, 2);
        let a1 = gate.acquire("a");
        let a2 = gate.acquire("a");
        assert!(a1.is_some() && a2.is_some());
        // 3rd for the same key exceeds per-key cap of 2.
        assert!(gate.acquire("a").is_none());
        // A different key still has room, up to the global cap of 3.
        let b1 = gate.acquire("b");
        assert!(b1.is_some());
        assert!(gate.acquire("b").is_none(), "global cap of 3 reached");
    }

    #[test]
    fn conn_guard_releases_slot_on_drop() {
        let gate = ConnGate::new(1, 1);
        {
            let _g = gate.acquire("a").expect("first acquire");
            assert!(gate.acquire("a").is_none(), "at cap while guard held");
        }
        // Guard dropped → slot freed → key map entry removed.
        assert!(gate.acquire("a").is_some(), "slot freed after drop");
    }

    #[test]
    fn client_ip_prefers_fly_header_then_falls_back() {
        let mut h = HeaderMap::new();
        assert_eq!(client_ip(&h), "unknown");
        h.insert("x-forwarded-for", "1.1.1.1, 2.2.2.2".parse().unwrap());
        assert_eq!(client_ip(&h), "1.1.1.1");
        h.insert("fly-client-ip", "9.9.9.9".parse().unwrap());
        assert_eq!(client_ip(&h), "9.9.9.9", "fly header wins");
    }
}
