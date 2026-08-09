/** User-facing strings that more than one screen shows.
 *
 *  These were duplicated verbatim across the lobby and the tournament page and
 *  had already started to drift apart. Anything a user can read in two places
 *  belongs here so it can only be worded once.
 *
 *  `SESSION_EXPIRED` deliberately stays in `authedFetch.ts`: the fetch wrapper
 *  that raises it owns it, and importing it from here would invert that. */

/** 503 from any game-creating route: the owner has drained the server. */
export const MAINTENANCE = "The server is in maintenance and can’t start new games right now.";

/** 424: the wallet has a bot seat registered but no agent is connected. */
export const BOT_OFFLINE = "Your bot is offline. Check the chess-client window.";
