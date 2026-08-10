// The user's BROWSER bot: a personalized in-browser Stockfish — an opening
// repertoire and a thinking style — with zero downloads. The native client
// (chess-client) is the power tier; this is the on-ramp.
//
// No display name lives here any more. A seat is labeled by the USERNAME of the
// wallet sitting in it, resolved server-side, because a name the client chose
// can name anybody — see `seat_info` in crates/server/src/main.rs.
//
// No uploaded book either. A visitor could hand this a Polyglot `.bin`, which
// lived in IndexedDB and was probed ahead of the repertoire. It was the most
// advanced control on the most beginner-facing surface, and it is fully covered
// one tier up — `chess-client --book <file>` takes any book, with a real engine
// behind it. What is left here is what a first-time visitor can actually use.
//
// Settings live in localStorage.

import { Chess } from "chessops/chess";

import {
  DEFAULT_REPERTOIRE,
  loadRepertoire,
  normalizeRepertoire,
  repertoireLabel,
  selectedBookIds,
  type Repertoire,
} from "./books";
import { pickBookMove, type BookEntry } from "./polyglot";
import { readMigrated, writeKey } from "./storage";
import { DEFAULT_TIME_POLICY, normalizeTimePolicy, timePolicyLabel, type TimePolicy } from "./timePolicy";

export type BrowserBotConfig = {
  /** Which built-in opening books this bot plays, per color/reply slot. */
  repertoire: Repertoire;
  /** How it spends its clock. */
  time: TimePolicy;
};

export const DEFAULT_CONFIG: BrowserBotConfig = {
  repertoire: DEFAULT_REPERTOIRE,
  time: DEFAULT_TIME_POLICY,
};

/** Field-by-field parse with per-field defaults, so a config written before a
 *  field existed simply gains it. Exported for the tests, which have no
 *  localStorage.
 *
 *  This rebuilds into a fresh object rather than spreading, which is what makes
 *  a removed field free: a blob still carrying `name` or `bookMaxPly` is simply
 *  never read, so neither needed a migration. */
export function parseBrowserBotConfig(raw: unknown): BrowserBotConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    repertoire: normalizeRepertoire(r.repertoire),
    time: normalizeTimePolicy(r.time),
  };
}

export function getBrowserBotConfig(): BrowserBotConfig {
  if (typeof window === "undefined") return DEFAULT_CONFIG;
  try {
    return parseBrowserBotConfig(JSON.parse(readMigrated("browserBot") ?? "{}"));
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** Read-modify-write, so an older tab writing a subset of the fields can't
 *  erase settings it doesn't know about.
 *
 *  A side effect worth knowing before you go looking: because this merges over
 *  the RAW stored blob, a `name` written before usernames existed survives in
 *  `openchess.browserBot` indefinitely. Nothing reads it (see
 *  `parseBrowserBotConfig`), so it is inert — but it is confusing in devtools,
 *  and it is not worth a migration to remove. */
export function saveBrowserBotConfig(cfg: Partial<BrowserBotConfig>) {
  let stored: unknown = {};
  try {
    stored = JSON.parse(readMigrated("browserBot") ?? "{}");
  } catch {
    /* corrupt blob — overwrite it */
  }
  writeKey("browserBot", JSON.stringify({ ...(stored as object), ...cfg }));
}

/** Engine label declared to opponents (informational, never verified). The
 *  browser bot always plays full strength; the suffix names the repertoire so
 *  the lobby shows what a bot actually opens with. The server caps declared
 *  labels at 48 chars, so keep this short. */
export function browserEngineLabel(cfg: BrowserBotConfig = getBrowserBotConfig()): string {
  const parts = [repertoireLabel(cfg.repertoire), timePolicyLabel(cfg.time)].filter(Boolean);
  return parts.length ? `Stockfish 18 · ${parts.join(" · ")}`.slice(0, 48) : "Stockfish 18 (browser)";
}

/** What a BROWSER seat declares when creating or joining a game: the engine, and
 *  nothing else.
 *
 *  Kept as a function rather than inlined at the four call sites because of the
 *  bug it exists to prevent — the gauntlet and tournament pages used to send
 *  nothing, so a browser bot's games in those modes recorded no engine at all
 *  while its park games did.
 *
 *  It no longer declares a NAME. The server resolves a seat's label from the
 *  username of the wallet in it and ignores anything the client sends, because
 *  a client-chosen name can name anybody. */
export function browserSeat(cfg: BrowserBotConfig = getBrowserBotConfig()): { engine: string } {
  return { engine: browserEngineLabel(cfg) };
}

// A previously-uploaded Polyglot book may still be sitting in IndexedDB under
// `openchess`/`books`. Nothing reads it now that the upload control is gone, and
// it is deliberately not deleted here: a one-shot cleanup would have to run on
// every page load of every visitor forever to catch the few who ever used it.
// Browsers evict unreferenced origin storage on their own.

// ---------------------------------------------------------------------------
// Selected repertoire (built-in books, fetched from /books/*.bin)
// ---------------------------------------------------------------------------

let repEntries: BookEntry[] | null = null;
/** Which selection `repEntries` is for, so changing the repertoire in another
 *  tab (or in the picker) invalidates rather than silently playing the old one. */
let repSig = "";
let repLoad: Promise<void> | null = null;

/** Load + merge the configured repertoire's books into memory (idempotent).
 *  Safe to call on every game start; a no-op once warm. */
export function ensureRepertoireLoaded(
  rep: Repertoire = getBrowserBotConfig().repertoire,
): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  const sig = selectedBookIds(rep).join(",");
  if (sig === repSig && repEntries) return Promise.resolve();
  if (!sig) {
    repSig = "";
    repEntries = null;
    return Promise.resolve();
  }
  if (repLoad && sig === repSig) return repLoad;
  repSig = sig;
  repLoad = loadRepertoire(rep)
    .then((entries) => {
      // A newer selection landed while we were fetching — don't clobber it.
      if (selectedBookIds(rep).join(",") === repSig) repEntries = entries;
    })
    .catch(() => {
      // A missing book must not break the game; we simply fall through to the
      // built-in book and then the engine.
      if (selectedBookIds(rep).join(",") === repSig) repEntries = null;
    })
    .finally(() => {
      repLoad = null;
    });
  return repLoad;
}

/** Synchronous probe of the selected repertoire (call ensureRepertoireLoaded
 *  first). `pick` decides between replaying one line forever and varying
 *  within the same theory. */
export function probeRepertoire(
  pos: Chess,
  ply: number,
  maxPly: number,
  pick: Repertoire["pick"],
): string | null {
  if (!repEntries || ply >= maxPly) return null;
  return pickBookMove(repEntries, pos, { pick });
}

/** Test/debug seam: drop the cached repertoire so the next ensure re-fetches. */
export function resetRepertoireCache() {
  repEntries = null;
  repSig = "";
  repLoad = null;
}
