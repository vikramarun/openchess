"use client";

import { useEffect, useRef, useState } from "react";

import { cooldownMessage, USERNAME_MAX, validateUsername } from "@/lib/username";
import { checkAvailable, setUsername } from "@/lib/usernameApi";
import { useAuthToken } from "@/lib/useAuthToken";

/** Claim or change the signed-in wallet's username.
 *
 *  Told everything by `ProfileStats` rather than fetching for itself, the same
 *  way `AvatarEditor` receives `hasPhoto` — the profile payload already carries
 *  both fields, so a second request would only be a second thing to keep in
 *  sync. Rendered on your own profile only (`editable`); the server takes the
 *  wallet from the session, so there is nothing to send for anyone else. */
export function UsernameEditor({
  username,
  nextChangeAt,
  onChanged,
}: {
  username: string | null;
  /** ISO date, or null when a change is allowed now. */
  nextChangeAt: string | null;
  onChanged: () => void;
}) {
  const token = useAuthToken();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [free, setFree] = useState<boolean | null>(null);
  // Monotonic, so a slow earlier probe can never overwrite a newer verdict —
  // aborting the request is not enough on its own, since a response already in
  // flight still resolves.
  const seq = useRef(0);

  const trimmed = draft.trim();
  const check = trimmed ? validateUsername(trimmed) : null;
  const unchanged = !!username && trimmed.toLowerCase() === username.toLowerCase();
  const locked = !!nextChangeAt;

  // Availability, debounced, and only once the name is locally legal — there is
  // no point asking the server about a string it would reject on grammar.
  useEffect(() => {
    setFree(null);
    if (!open || locked || unchanged || !check?.ok) return;
    const mine = ++seq.current;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      checkAvailable(trimmed, ctl.signal)
        .then((ok) => {
          if (mine === seq.current) setFree(ok);
        })
        .catch(() => {});
    }, 350);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [trimmed, open, locked, unchanged, check?.ok]);

  if (!token) {
    return (
      <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
        Sign in to pick a username.
      </div>
    );
  }

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await setUsername(trimmed);
      setOpen(false);
      setDraft("");
      onChanged();
    } catch (e) {
      // Already the user-facing sentence — `setUsername` maps the status and
      // body through `usernameFailure`. Includes the 409 a passing availability
      // probe cannot rule out: somebody can claim the name in between.
      setErr(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  // Closed state: what they have, and the way in.
  if (!open) {
    return (
      <div style={{ marginTop: 8 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button
            className="ghost"
            style={{ fontSize: 13, padding: "4px 10px" }}
            disabled={locked}
            onClick={() => {
              setDraft(username ?? "");
              setErr(null);
              setOpen(true);
            }}
          >
            {username ? "Change username" : "Pick a username"}
          </button>
          {/* A disabled control with no explanation is the worst version of
              this, so the reason always rides along with the lock. */}
          <span className="muted" style={{ fontSize: 12 }}>
            {locked
              ? `${cooldownMessage(nextChangeAt)} (${new Date(nextChangeAt).toLocaleDateString()})`
              : username
                ? "You can change it once a week."
                : `3–${USERNAME_MAX} letters, numbers or underscores.`}
          </span>
        </div>
      </div>
    );
  }

  const blocked = !trimmed || !check?.ok || unchanged || busy || free === false;
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          autoFocus
          value={draft}
          maxLength={USERNAME_MAX}
          placeholder="username"
          aria-label="Username"
          spellCheck={false}
          autoCapitalize="none"
          autoComplete="off"
          style={{ maxWidth: 220 }}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !blocked) void save();
            if (e.key === "Escape") setOpen(false);
          }}
        />
        <button style={{ fontSize: 13, padding: "4px 10px" }} disabled={blocked} onClick={() => void save()}>
          {busy ? "Saving…" : username ? "Change" : "Claim"}
        </button>
        <button
          className="ghost"
          style={{ fontSize: 13, padding: "4px 10px" }}
          disabled={busy}
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
      </div>
      <div style={{ fontSize: 12, marginTop: 6 }}>
        {check && !check.ok ? (
          <span style={{ color: "var(--danger)" }}>{check.error}</span>
        ) : unchanged ? (
          <span className="muted">That’s already your username.</span>
        ) : free === false ? (
          <span style={{ color: "var(--danger)" }}>That username is taken.</span>
        ) : free === true ? (
          <span className="muted">✓ available</span>
        ) : (
          <span className="muted">
            {username
              ? "You won’t be able to change it again for a week."
              : `3–${USERNAME_MAX} letters, numbers or underscores. You can change it once a week.`}
          </span>
        )}
      </div>
      {err && <div style={{ color: "var(--danger)", fontSize: 13, marginTop: 6 }}>{err}</div>}
    </div>
  );
}
