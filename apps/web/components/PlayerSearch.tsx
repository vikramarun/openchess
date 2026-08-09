"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { isAddress, isUsernameShape, shortAddress } from "@/lib/address";
import { avatarUrl } from "@/lib/avatar";
import { playerLabel } from "@/lib/playerLabel";
import { searchPlayers, type PlayerHit } from "@/lib/usernameApi";

/** Find a player by username, or paste a wallet address.
 *
 *  A typeahead over `GET /players/search`, which prefix-matches usernames. A raw
 *  address still works and is offered as its own row, because that is the only
 *  way to reach the many wallets that have never claimed a handle. */
export function PlayerSearch({ placeholder }: { placeholder?: string }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<PlayerHit[]>([]);
  const [at, setAt] = useState(0);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  // Monotonic: aborting the previous request is not enough on its own, since a
  // response already in flight still resolves and would overwrite a newer one.
  const seq = useRef(0);

  const term = q.trim();
  const addr = isAddress(term.toLowerCase()) ? term.toLowerCase() : null;

  useEffect(() => {
    // The server ignores a one-character query too — a prefix that short is a
    // scan of the whole table for a result nobody can read yet.
    if (term.length < 2) {
      setHits([]);
      return;
    }
    const mine = ++seq.current;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      searchPlayers(term, ctl.signal).then((h) => {
        if (mine === seq.current) {
          setHits(h);
          setAt(0);
        }
      });
    }, 250);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [term]);

  // Close on outside click or Escape — the same idiom as WalletMenu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const go = (ident: string) => {
    setOpen(false);
    router.push(`/player/${ident}`);
  };

  // The address row sits on top when the query IS one, so pasting a wallet and
  // pressing Enter still works even with zero username matches.
  const rows: { key: string; ident: string; node: React.ReactNode }[] = [
    ...(addr
      ? [
          {
            key: `addr:${addr}`,
            ident: addr,
            node: (
              <>
                <span className="ps-av">♟</span>
                <span style={{ flex: 1 }}>Go to {shortAddress(addr)}</span>
              </>
            ),
          },
        ]
      : []),
    ...hits.map((h) => ({
      key: h.address,
      // Prefer the handle in the URL — it's the canonical form (see the
      // per-segment canonical in the route's generateMetadata).
      ident: h.username || h.address,
      node: (
        <>
          <span className="ps-av">
            {avatarUrl(h.address, h.avatar_updated_at) ? (
              <img src={avatarUrl(h.address, h.avatar_updated_at)!} alt="" />
            ) : (
              "♟"
            )}
          </span>
          <span style={{ flex: 1 }}>{playerLabel({ username: h.username, address: h.address })}</span>
          <span className="muted" style={{ fontSize: 12 }}>
            {h.rating}
          </span>
        </>
      ),
    })),
  ];

  const submit = () => {
    if (rows.length) return go(rows[Math.min(at, rows.length - 1)].ident);
    // Never push an unvalidated string into a route.
    if (addr || isUsernameShape(term)) return go(addr ?? term);
    setErr("No player by that name.");
  };

  return (
    <div ref={box} style={{ position: "relative" }}>
      <input
        value={q}
        role="combobox"
        aria-expanded={open && rows.length > 0}
        aria-controls="player-search-list"
        aria-label="Find a player"
        placeholder={placeholder ?? "username or 0x… address"}
        spellCheck={false}
        autoCapitalize="none"
        autoComplete="off"
        style={{ width: "100%" }}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQ(e.target.value);
          setErr(null);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setAt((i) => Math.min(i + 1, rows.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setAt((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
      />
      {open && rows.length > 0 && (
        <ul id="player-search-list" role="listbox" className="ps-list">
          {rows.map((r, i) => (
            <li
              key={r.key}
              role="option"
              aria-selected={i === at}
              className={i === at ? "on" : undefined}
              onMouseEnter={() => setAt(i)}
              onMouseDown={(e) => {
                // mousedown, not click: the input's blur would close the list
                // first and the click would land on nothing.
                e.preventDefault();
                go(r.ident);
              }}
            >
              {r.node}
            </li>
          ))}
        </ul>
      )}
      {err && <div style={{ color: "var(--danger)", fontSize: 13, marginTop: 6 }}>{err}</div>}
    </div>
  );
}
