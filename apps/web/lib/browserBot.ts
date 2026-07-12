// The user's BROWSER bot: a personalized in-browser Stockfish — display name,
// and an uploaded Polyglot opening book — with zero downloads. The
// native client (chess-client) is the power tier; this is the on-ramp.
//
// Settings live in localStorage; the (potentially large) book lives in
// IndexedDB and is parsed once per session into memory for synchronous
// probing on each move.

import { Chess } from "chessops/chess";

import { parseBook, pickBookMove, type BookEntry } from "./polyglot";

export type BrowserBotConfig = {
  /** Display name shown to opponents; "" = default. */
  name: string;
  /** Stop using the uploaded book after this many plies. */
  bookMaxPly: number;
};

export const DEFAULT_CONFIG: BrowserBotConfig = {
  name: "",
  bookMaxPly: 16,
};

const CONFIG_KEY = "browser_bot_config";

/** Clamp a numeric config field, treating a valid 0 as 0 (not falsy-default). */
function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
}

export function getBrowserBotConfig(): BrowserBotConfig {
  if (typeof window === "undefined") return DEFAULT_CONFIG;
  try {
    const raw = JSON.parse(localStorage.getItem(CONFIG_KEY) ?? "{}");
    return {
      name: typeof raw.name === "string" ? raw.name.slice(0, 48) : "",
      bookMaxPly: clampInt(raw.bookMaxPly, 0, 60, DEFAULT_CONFIG.bookMaxPly),
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveBrowserBotConfig(cfg: BrowserBotConfig) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

/** Engine label declared to opponents (informational). The browser bot always
 *  plays full strength — no scaler. */
export function browserEngineLabel(): string {
  return "Stockfish 18 (browser)";
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
  if (entries.length === 0) throw new Error("book contains no entries");
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
