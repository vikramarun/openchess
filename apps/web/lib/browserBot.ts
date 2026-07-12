// The user's BROWSER bot: a personalized in-browser Stockfish — display name,
// strength, and an uploaded Polyglot opening book — with zero downloads. The
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
  /** "max" = full strength; number = UCI_Elo target (Stockfish ~1320..3190). */
  strength: "max" | number;
  /** Engine hash table in MB (WASM builds accept small values). */
  hashMb: number;
  /** Stop using the uploaded book after this many plies. */
  bookMaxPly: number;
};

export const DEFAULT_CONFIG: BrowserBotConfig = {
  name: "",
  strength: "max",
  hashMb: 32,
  bookMaxPly: 16,
};

export const MIN_ELO = 1320;
export const MAX_ELO = 3190;

const CONFIG_KEY = "browser_bot_config";

export function getBrowserBotConfig(): BrowserBotConfig {
  if (typeof window === "undefined") return DEFAULT_CONFIG;
  try {
    const raw = JSON.parse(localStorage.getItem(CONFIG_KEY) ?? "{}");
    const strength =
      raw.strength === "max"
        ? ("max" as const)
        : Math.min(MAX_ELO, Math.max(MIN_ELO, Number(raw.strength) || MAX_ELO));
    return {
      name: typeof raw.name === "string" ? raw.name.slice(0, 48) : "",
      strength: raw.strength === undefined ? "max" : strength,
      hashMb: Math.min(128, Math.max(16, Number(raw.hashMb) || DEFAULT_CONFIG.hashMb)),
      bookMaxPly: Math.min(60, Math.max(0, Number(raw.bookMaxPly) || DEFAULT_CONFIG.bookMaxPly)),
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveBrowserBotConfig(cfg: BrowserBotConfig) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

/** Engine label declared to opponents (informational). */
export function browserEngineLabel(cfg: BrowserBotConfig = getBrowserBotConfig()): string {
  return cfg.strength === "max"
    ? "Stockfish (browser)"
    : `Stockfish (browser, ~${cfg.strength} Elo)`;
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

/** Validate + persist an uploaded Polyglot .bin; returns its stats. */
export async function saveUserBook(file: File): Promise<BookInfo> {
  const bytes = await file.arrayBuffer();
  const entries = parseBook(bytes); // throws on malformed input
  if (entries.length === 0) throw new Error("book contains no entries");
  await idb("readwrite", (s) => s.put({ name: file.name, bytes }, BOOK_KEY));
  cachedEntries = entries;
  cachedInfo = { name: file.name, positions: entries.length };
  return cachedInfo;
}

export async function clearUserBook(): Promise<void> {
  await idb("readwrite", (s) => s.delete(BOOK_KEY));
  cachedEntries = null;
  cachedInfo = null;
}

/** Load + parse the stored book into the in-memory cache (idempotent). */
export function ensureBookLoaded(): Promise<void> {
  if (typeof window === "undefined" || cachedEntries) return Promise.resolve();
  if (!loadPromise) {
    loadPromise = idb<{ name: string; bytes: ArrayBuffer } | undefined>("readonly", (s) =>
      s.get(BOOK_KEY),
    )
      .then((row) => {
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
 *  Returns the highest-weight book move as UCI, or null. */
export function probeUserBook(pos: Chess, ply: number): string | null {
  if (!cachedEntries || ply >= getBrowserBotConfig().bookMaxPly) return null;
  return pickBookMove(cachedEntries, pos);
}
