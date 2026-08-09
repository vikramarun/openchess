/** User-facing strings that more than one screen shows.
 *
 *  These were duplicated verbatim across the lobby, the gauntlet, and the
 *  tournament page and had already started to drift apart. Anything a user can
 *  read in two places belongs here so it can only be worded once.
 *
 *  The `_MSG` suffix is load-bearing: `lib/bot.ts` already exports a
 *  `BOT_OFFLINE`, and that one is a `BotStatus` sentinel rather than a string.
 *  A file that needs both should not have to alias one of them.
 *
 *  `SESSION_EXPIRED` deliberately stays in `authedFetch.ts`: the fetch wrapper
 *  that raises it owns it, and importing it from here would invert that. */

/** 503 from any game-creating route: the owner has drained the server. Every
 *  create endpoint returns this during a drain, not just the lobby's. */
export const MAINTENANCE_MSG =
  "The server is in maintenance and can’t start new games right now.";

/** 424: the wallet has a bot seat registered but no agent is connected. */
export const BOT_OFFLINE_MSG = "Your bot is offline. Check the chess-client window.";
