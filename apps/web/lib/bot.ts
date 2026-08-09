// Your connected bot (a user-run UCI engine in `chess-client connect` mode).
// The server keeps one agent per wallet; the web app polls its status and
// dispatches seats to it when you choose to play with the bot.

import { useEffect, useState } from "react";

import { authedFetch } from "./authedFetch";
import { SERVER_HTTP } from "./config";
import { readMigrated, writeKey } from "./storage";

export type UciOptionInfo = {
  name: string;
  kind: string; // check | spin | combo | button | string
  default?: string | null;
  min?: string | null;
  max?: string | null;
};

export type BotStatus = {
  online: boolean;
  busy: boolean;
  name: string | null;
  engine: string | null;
  options: UciOptionInfo[];
};

export const BOT_OFFLINE: BotStatus = {
  online: false,
  busy: false,
  name: null,
  engine: null,
  options: [],
};

/** Poll the signed-in user's own bot status. Takes no token: `authedFetch`
 *  reads the stored session, so a token that expired mid-poll is dropped here
 *  too rather than retried forever. */
export async function fetchBot(): Promise<BotStatus> {
  try {
    const r = await authedFetch(`${SERVER_HTTP}/agent`);
    if (!r.ok) return BOT_OFFLINE;
    return (await r.json()) as BotStatus;
  } catch {
    return BOT_OFFLINE;
  }
}

/** React hook: the signed-in user's connected-bot status, polled every
 *  `intervalMs` while `token` is set (offline when signed out). Shared by the
 *  lobby, gauntlet, tournament, and connect pages (connect polls faster for
 *  snappy "online" feedback the moment the client pairs). */
export function useBotStatus(token: string | null, intervalMs = 5000): BotStatus {
  const [bot, setBot] = useState<BotStatus>(BOT_OFFLINE);
  useEffect(() => {
    if (!token) {
      setBot(BOT_OFFLINE);
      return;
    }
    let alive = true;
    const tick = () => fetchBot().then((b) => alive && setBot(b));
    tick();
    const t = setInterval(tick, intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [token, intervalMs]);
  return bot;
}

/** User-configured UCI option overrides, persisted locally and sent with each
 *  bot game so the agent applies them (Threads, Hash, Skill Level, …). */
export function loadBotOptions(): Record<string, string> {
  try {
    return JSON.parse(readMigrated("botOptions") ?? "{}");
  } catch {
    return {};
  }
}

export function saveBotOptions(opts: Record<string, string>) {
  const cleaned = Object.fromEntries(
    Object.entries(opts).filter(([k, v]) => k.trim() && v.trim()),
  );
  writeKey("botOptions", JSON.stringify(cleaned));
}
