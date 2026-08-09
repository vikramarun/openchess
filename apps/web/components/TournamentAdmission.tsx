"use client";

import { useCallback, useEffect, useState } from "react";

import {
  decideRequest,
  listInvites,
  listRequests,
  mintInvites,
  type Invite,
  type SeatRequest,
} from "@/lib/admission";
import { entrantLabel, type Admission, type Tournament } from "@/lib/tournaments";

// Applicants are wallets. Prefer a claimed handle when the tournament view
// already resolved one (an approved entrant who has joined will have it), else
// the shared shortener — never a bare 42-character address, and never a
// second local copy of the truncation rule.

/** The organizer's side of a gated tournament: mint and watch invite codes, or
 *  decide who gets in.
 *
 *  Only rendered for the organizer — every route behind it is wallet-gated and
 *  403s anyone else, and the unused codes are the credentials, so showing this
 *  to the field would be handing out the keys. */
export function TournamentAdmission({ t }: { t: Tournament }) {
  const mode: Admission = t.admission;
  const [invites, setInvites] = useState<Invite[]>([]);
  const [requests, setRequests] = useState<SeatRequest[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      if (mode === "invite") setInvites(await listInvites(t.id));
      else if (mode === "approval") setRequests(await listRequests(t.id));
      setErr(null);
    } catch {
      /* transient — the next tick retries, and a stale list is harmless here */
    }
  }, [mode, t.id]);

  useEffect(() => {
    if (mode === "open") return;
    load();
    const iv = setInterval(load, 5000);
    return () => clearInterval(iv);
  }, [mode, load]);

  if (mode === "open") return null;

  const mint = async (count: number) => {
    setErr(null);
    setBusy(true);
    try {
      await mintInvites(t.id, count);
      await load();
    } catch {
      setErr("Couldn’t mint codes.");
    } finally {
      setBusy(false);
    }
  };

  const decide = async (wallet: string, approve: boolean) => {
    setErr(null);
    setBusy(true);
    try {
      await decideRequest(t.id, wallet, approve);
      await load();
    } catch {
      setErr("Couldn’t record that decision.");
    } finally {
      setBusy(false);
    }
  };

  const copy = (code: string) => {
    navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(code);
        setTimeout(() => setCopied((c) => (c === code ? null : c)), 1500);
      },
      () => setErr("Couldn’t copy — select the code and copy it manually."),
    );
  };

  const unused = invites.filter((i) => !i.used_by);
  const pending = requests.filter((r) => r.state === "pending");
  // Entrant ids are wallets for a pooled tournament and display names for a
  // casual one; only the former can match an approval, which is keyed on the
  // wallet. Lowercased because the server compares identities that way.
  const inField = new Set(t.players.map((p) => p.toLowerCase()));

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <b style={{ color: "var(--text-strong)" }}>
        {mode === "invite" ? "Invite codes" : "Join requests"}
      </b>

      {mode === "invite" ? (
        <>
          <div className="muted" style={{ fontSize: 13, margin: "4px 0 8px" }}>
            {unused.length} unused of {invites.length}. Each code lets exactly one entrant in —
            share them privately.
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <button className="ghost" onClick={() => mint(1)} disabled={busy}>
              Mint a code
            </button>
            <button className="ghost" onClick={() => mint(5)} disabled={busy}>
              Mint 5
            </button>
          </div>
          {invites.length === 0 ? (
            <div className="muted" style={{ fontSize: 13 }}>
              No codes yet — nobody can join until you mint one.
            </div>
          ) : (
            <div style={{ display: "grid", gap: 6 }}>
              {invites.map((i) => (
                <div
                  key={i.code}
                  style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}
                >
                  <code style={{ opacity: i.used_by ? 0.5 : 1 }}>{i.code}</code>
                  {i.used_by ? (
                    <span className="muted">used by {entrantLabel(t, i.used_by)}</span>
                  ) : (
                    <button className="ghost" onClick={() => copy(i.code)}>
                      {copied === i.code ? "Copied ✓" : "Copy"}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="muted" style={{ fontSize: 13, margin: "4px 0 8px" }}>
            {pending.length === 0
              ? "No one waiting."
              : `${pending.length} waiting on you.`}{" "}
            Approving does not charge anyone — they still have to join afterwards.
          </div>
          {requests.length === 0 ? (
            <div className="muted" style={{ fontSize: 13 }}>
              Nobody has asked to join yet.
            </div>
          ) : (
            <div style={{ display: "grid", gap: 6 }}>
              {requests.map((r) => (
                <div
                  key={r.wallet}
                  style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}
                >
                  <span style={{ minWidth: 130 }}>{entrantLabel(t, r.wallet)}</span>
                  {r.state === "pending" ? (
                    <>
                      <button
                        className="ghost"
                        onClick={() => decide(r.wallet, true)}
                        disabled={busy}
                      >
                        Approve
                      </button>
                      <button
                        className="ghost"
                        onClick={() => decide(r.wallet, false)}
                        disabled={busy}
                      >
                        Decline
                      </button>
                    </>
                  ) : inField.has(r.wallet.toLowerCase()) ? (
                    // Once they've joined, the approval has done its job and
                    // changing it back would be a button that appears to remove
                    // someone from the field and doesn't.
                    <span className="muted">in the field</span>
                  ) : (
                    <span className="muted">
                      {r.state === "approved" ? "approved ✓" : "declined"}
                      {/* Not yet joined, so the decision is still live: an
                          organizer who mis-clicked can put it right, and the
                          server simply overwrites the entry. */}
                      {" · "}
                      <button
                        className="ghost"
                        onClick={() => decide(r.wallet, r.state !== "approved")}
                        disabled={busy}
                      >
                        {r.state === "approved" ? "Revoke" : "Approve"}
                      </button>
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {err && <div style={{ color: "#e06c6c", fontSize: 12, marginTop: 6 }}>{err}</div>}
    </div>
  );
}
