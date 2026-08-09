// The user's BROWSER bot: a personalized in-browser Stockfish — display name,
// and an uploaded Polyglot opening book — with zero downloads. The
// native client (chess-client) is the power tier; this is the on-ramp.
//
// Settings live in localStorage; the (potentially large) book lives in
// IndexedDB and is parsed once per session into memory for synchronous
// probing on each move.

import { Chess } from "chessops/chess";

import {
  DEFAULT_REPERTOIRE,
  loadRepertoire,
  normalizeRepertoire,
  repertoireLabel,
  selectedBookIds,
  type Repertoire,
} from "./books";
import { parseBook, pickBookMove, type BookEntry } from "./polyglot";
import { DEFAULT_TIME_POLICY, normalizeTimePolicy, timePolicyLabel, type TimePolicy } from "./timePolicy";

export type BrowserBotConfig = {
  /** Display name shown to opponents; "" = default. */
  name: string;
  /** Stop using an opening book after this many plies. */
  bookMaxPly: number;
  /** Which built-in opening books this bot plays, per colour/reply slot. */
  repertoire: Repertoire;
  /** How it spends its clock. */
  time: TimePolicy;
};

export const DEFAULT_CONFIG: BrowserBotConfig = {
  name: "",
  bookMaxPly: 16,
  repertoire: DEFAULT_REPERTOIRE,
  time: DEFAULT_TIME_POLICY,
};

const CONFIG_KEY = "browser_bot_config";

/** Clamp a numeric config field, treating a valid 0 as 0 (not falsy-default). */
function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
}

/** Field-by-field parse with per-field defaults, so a config written before
 *  repertoires existed keeps its name and book setting and simply gains the
 *  new field. Exported for the tests, which have no localStorage. */
export function parseBrowserBotConfig(raw: unknown): BrowserBotConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    name: typeof r.name === "string" ? r.name.slice(0, 48) : "",
    bookMaxPly: clampInt(r.bookMaxPly, 0, 60, DEFAULT_CONFIG.bookMaxPly),
    repertoire: normalizeRepertoire(r.repertoire),
    time: normalizeTimePolicy(r.time),
  };
}

export function getBrowserBotConfig(): BrowserBotConfig {
  if (typeof window === "undefined") return DEFAULT_CONFIG;
  try {
    return parseBrowserBotConfig(JSON.parse(localStorage.getItem(CONFIG_KEY) ?? "{}"));
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** Read-modify-write, so an older tab writing a subset of the fields can't
 *  erase settings it doesn't know about. */
export function saveBrowserBotConfig(cfg: Partial<BrowserBotConfig>) {
  let stored: unknown = {};
  try {
    stored = JSON.parse(localStorage.getItem(CONFIG_KEY) ?? "{}");
  } catch {
    /* corrupt blob — overwrite it */
  }
  localStorage.setItem(CONFIG_KEY, JSON.stringify({ ...(stored as object), ...cfg }));
}

/** Engine label declared to opponents (informational, never verified). The
 *  browser bot always plays full strength; the suffix names the repertoire so
 *  the lobby shows what a bot actually opens with. The server caps declared
 *  labels at 48 chars, so keep this short. */
export function browserEngineLabel(cfg: BrowserBotConfig = getBrowserBotConfig()): string {
  const parts = [repertoireLabel(cfg.repertoire), timePolicyLabel(cfg.time)].filter(Boolean);
  return parts.length ? `Stockfish 18 · ${parts.join(" · ")}`.slice(0, 48) : "Stockfish 18 (browser)";
}

/** The identity a BROWSER seat declares when creating or joining a game.
 *
 *  Lives here rather than in the lobby because all three modes need it. The
 *  gauntlet and tournament pages used to send nothing, so a browser bot's games
 *  in those modes recorded no engine at all while its park games did. */
export function browserSeat(cfg: BrowserBotConfig = getBrowserBotConfig()): {
  name?: string;
  engine: string;
} {
  return {
    ...(cfg.name.trim() ? { name: cfg.name.trim() } : {}),
    engine: browserEngineLabel(cfg),
  };
}

// ---------------------------------------------------------------------------
// Uploaded opening book (IndexedDB) + in-memory probe cache
// ---------------------------------------------------------------------------

export type BookInfo = { name: string; positions: number };

const DB_NAME = "openchess";
const STORE = "books";
const BOOK_KEY = "user";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idb<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

let cachedEntries: BookEntry[] | null = null;
let cachedInfo: BookInfo | null = null;
let loadPromise: Promise<void> | null = null;
// Bumped on every save/clear so an in-flight load that resolves afterward can
// tell it's stale and refuse to repopulate the cache with a superseded book.
let generation = 0;

/** Validate + persist an uploaded Polyglot .bin; returns its stats. */
export async function saveUserBook(file: File): Promise<BookInfo> {
  const bytes = await file.arrayBuffer();
  const entries = parseBook(bytes); // throws on malformed input
  if (entries.length === 0) throw new Error("That book contains no entries.");
  await idb("readwrite", (s) => s.put({ name: file.name, bytes }, BOOK_KEY));
  generation++;
  cachedEntries = entries;
  cachedInfo = { name: file.name, positions: entries.length };
  return cachedInfo;
}

export async function clearUserBook(): Promise<void> {
  generation++;
  cachedEntries = null;
  cachedInfo = null;
  await idb("readwrite", (s) => s.delete(BOOK_KEY));
}

/** Load + parse the stored book into the in-memory cache (idempotent). */
export function ensureBookLoaded(): Promise<void> {
  if (typeof window === "undefined" || cachedEntries) return Promise.resolve();
  if (!loadPromise) {
    const gen = generation;
    loadPromise = idb<{ name: string; bytes: ArrayBuffer } | undefined>("readonly", (s) =>
      s.get(BOOK_KEY),
    )
      .then((row) => {
        // A save/clear during the read supersedes us — don't clobber it.
        if (gen !== generation) return;
        if (row) {
          cachedEntries = parseBook(row.bytes);
          cachedInfo = { name: row.name, positions: cachedEntries.length };
        }
      })
      .catch(() => {})
      .finally(() => {
        loadPromise = null;
      });
  }
  return loadPromise;
}

export async function userBookInfo(): Promise<BookInfo | null> {
  await ensureBookLoaded();
  return cachedInfo;
}

/** Synchronous probe of the uploaded book (call ensureBookLoaded first).
 *  Returns the highest-weight book move as UCI, or null. `maxPly` is passed in
 *  (rather than read from config here) so this stays cheap in the move loop. */
export function probeUserBook(pos: Chess, ply: number, maxPly: number): string | null {
  if (!cachedEntries || ply >= maxPly) return null;
  return pickBookMove(cachedEntries, pos);
}

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
