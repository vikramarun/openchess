"use client";

import { useEffect, useState } from "react";

import { BookTree } from "@/components/BookTree";
import {
  BOOKS,
  booksForSlot,
  loadRepertoire,
  PRESETS,
  selectedBookIds,
  SLOTS,
  type Repertoire,
} from "@/lib/books";
import type { BookEntry } from "@/lib/polyglot";

const KB = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

/** Pick what your bot opens with — as White, and as Black against each of the
 *  three replies that matter.
 *
 *  A repertoire is the one part of a bot's personality that costs no strength:
 *  playing the Najdorf every game is established theory, not a worse move. So
 *  this is the headline control, and the preview below it is the point — you
 *  can see the actual lines before you commit to them. */
export function RepertoirePicker({
  repertoire,
  onChange,
}: {
  repertoire: Repertoire;
  onChange: (patch: Partial<Repertoire>) => void;
}) {
  const [entries, setEntries] = useState<BookEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const sig = selectedBookIds(repertoire).join(",");
  useEffect(() => {
    let live = true;
    if (!sig) {
      setEntries([]);
      setErr(null);
      return;
    }
    setLoading(true);
    setErr(null);
    loadRepertoire(repertoire)
      .then((e) => live && setEntries(e))
      .catch(() => live && setErr("Couldn't load those books — check your connection."))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // Keyed on the selection, not the object identity: maxPly/pick changes
    // don't need a refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  const activePreset = PRESETS.find(
    (p) =>
      p.rep.white === repertoire.white &&
      p.rep.vsE4 === repertoire.vsE4 &&
      p.rep.vsD4 === repertoire.vsD4 &&
      p.rep.vsOther === repertoire.vsOther,
  );
  const totalBytes = selectedBookIds(repertoire).reduce(
    (s, id) => s + (BOOKS.find((b) => b.id === id)?.bytes ?? 0),
    0,
  );

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {/* Presets fill all four slots; every slot stays editable afterward. */}
      <div>
        <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>
          Start from a style
        </div>
        <div className="rep-presets">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              className={`rep-preset${activePreset?.id === p.id ? " active" : ""}`}
              onClick={() => onChange(p.rep)}
              title={p.blurb}
            >
              <span className="rp-name">{p.label}</span>
              <span className="rp-blurb">{p.blurb}</span>
            </button>
          ))}
          <button
            className={`rep-preset${selectedBookIds(repertoire).length === 0 ? " active" : ""}`}
            onClick={() => onChange({ white: null, vsE4: null, vsD4: null, vsOther: null })}
            title="No book — the engine calculates from move one"
          >
            <span className="rp-name">No book</span>
            <span className="rp-blurb">Engine from move one. Slower openings, zero theory.</span>
          </button>
        </div>
      </div>

      {/* The four slots. */}
      <div className="rep-slots">
        {SLOTS.map(({ slot, label }) => (
          <label key={slot} className="rep-slot">
            <span className="muted" style={{ fontSize: 13 }}>
              {label}
            </span>
            <select
              value={repertoire[slot] ?? ""}
              onChange={(e) => onChange({ [slot]: e.target.value || null } as Partial<Repertoire>)}
            >
              <option value="">— none —</option>
              {booksForSlot(slot).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label} ({KB(b.bytes)})
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>

      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
        <label className="muted" style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "center" }}>
          Leave book after ply
          <input
            type="number"
            min={0}
            max={60}
            value={repertoire.maxPly}
            onChange={(e) => onChange({ maxPly: e.target.value === "" ? 16 : Number(e.target.value) })}
            style={{ width: 64 }}
          />
        </label>
        <label className="muted" style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "center" }}>
          Variety
          <select
            value={repertoire.pick}
            onChange={(e) => onChange({ pick: e.target.value === "best" ? "best" : "weighted" })}
          >
            <option value="weighted">Vary within theory</option>
            <option value="best">Always the main line</option>
          </select>
        </label>
        {totalBytes > 0 && (
          <span className="muted" style={{ fontSize: 12 }}>
            {KB(totalBytes)} of book, downloaded once
          </span>
        )}
      </div>

      {/* See it before you commit to it. */}
      {err && <div style={{ color: "var(--danger)", fontSize: 13 }}>{err}</div>}
      {loading && (
        <div className="muted" style={{ fontSize: 13 }}>
          Loading books…
        </div>
      )}
      {!loading && !err && entries && <BookTree entries={entries} maxPly={repertoire.maxPly} />}
    </div>
  );
}
