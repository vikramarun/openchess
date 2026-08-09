"use client";

import { Chess } from "chessops/chess";
import { INITIAL_FEN, makeFen } from "chessops/fen";
import { makeSan } from "chessops/san";
import { parseUci } from "chessops/util";
import { useMemo, useState } from "react";

import { Chessboard } from "@/components/Chessboard";
import { bookChildren, bookMainline, positionAfter } from "@/lib/bookTree";
import type { BookEntry } from "@/lib/polyglot";

/** Render a UCI history as numbered SAN ("1.e4 c5 2.Nf3"). Returns per-ply
 *  pieces so each move stays individually clickable. */
function sanPath(history: string[]): { san: string; number: string }[] {
  const pos = Chess.default();
  const out: { san: string; number: string }[] = [];
  history.forEach((uci, ply) => {
    const m = parseUci(uci);
    if (!m || !pos.isLegal(m)) return;
    out.push({ san: makeSan(pos, m), number: ply % 2 === 0 ? `${ply / 2 + 1}.` : "" });
    pos.play(m);
  });
  return out;
}

/** Browse a repertoire: the line it plays unopposed, plus every alternative it
 *  knows at any point you click to.
 *
 *  This is the honest-UI moment of the whole feature — you can see that the
 *  repertoire is real theory, and see exactly where it runs out and the engine
 *  takes over. */
export function BookTree({ entries, maxPly = 12 }: { entries: BookEntry[]; maxPly?: number }) {
  const [path, setPath] = useState<string[]>([]);

  const mainline = useMemo(() => bookMainline(entries, maxPly), [entries, maxPly]);
  const pos = useMemo(() => positionAfter(path), [path]);
  const children = useMemo(() => (pos ? bookChildren(entries, pos) : []), [entries, pos]);
  const fen = useMemo(() => (pos ? makeFen(pos.toSetup()) : INITIAL_FEN), [pos]);
  const crumbs = useMemo(() => sanPath(path), [path]);
  const lastMove = useMemo((): [string, string] | null => {
    const last = path[path.length - 1];
    return last ? [last.slice(0, 2), last.slice(2, 4)] : null;
  }, [path]);

  if (entries.length === 0) {
    return (
      <div className="muted" style={{ fontSize: 13 }}>
        No opening book selected — your bot plays from the engine on move one.
      </div>
    );
  }

  const outOfBook = children.length === 0;

  return (
    <div className="book-tree">
      <div className="book-tree-board">
        <Chessboard fen={fen} lastMove={lastMove} check />
      </div>

      <div className="book-tree-lines">
        {/* What it plays if nobody deviates. */}
        <div className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 }}>
          Main line
        </div>
        <div className="book-mainline">
          {mainline.length === 0 ? (
            <span className="muted">—</span>
          ) : (
            mainline.map((m, i) => (
              <button
                key={i}
                className={`book-move${i < path.length ? " played" : ""}`}
                onClick={() => setPath(mainline.slice(0, i + 1).map((x) => x.uci))}
              >
                {i % 2 === 0 ? `${i / 2 + 1}.` : ""}
                {m.san}
              </button>
            ))
          )}
        </div>

        {/* Where you are now, and how to get back. */}
        <div className="book-crumbs">
          <button className="book-move" onClick={() => setPath([])} disabled={path.length === 0}>
            start
          </button>
          {crumbs.map((c, i) => (
            <button key={i} className="book-move" onClick={() => setPath(path.slice(0, i + 1))}>
              {c.number}
              {c.san}
            </button>
          ))}
          {path.length > 0 && (
            <button className="book-move" onClick={() => setPath(path.slice(0, -1))} title="Back one move">
              ←
            </button>
          )}
        </div>

        {/* Every reply the book knows here. */}
        {outOfBook ? (
          <div className="muted" style={{ fontSize: 13, padding: "8px 0" }}>
            Out of book here — the engine takes over from this position.
          </div>
        ) : (
          <div className="book-options">
            {children.map((c) => (
              <button key={c.uci} className="book-option" onClick={() => setPath([...path, c.uci])}>
                <span className="bo-san">{c.san}</span>
                <span className="bo-bar">
                  <span className="bo-fill" style={{ width: `${Math.max(2, c.share * 100)}%` }} />
                </span>
                <span className="bo-pct">{(c.share * 100).toFixed(0)}%</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
