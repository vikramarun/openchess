-- Wallet lookups across the app match case-insensitively via lower(wallet)
-- (the leaderboard GROUP BY join, per-address profile stats/history, rating
-- updates), but the only wallet indexes were on the raw values — unusable for a
-- lower() predicate. Add functional (lowercased) indexes so those queries hit an
-- index instead of scanning.
CREATE INDEX IF NOT EXISTS games_white_wallet_lower_idx ON games (lower(white_wallet));
CREATE INDEX IF NOT EXISTS games_black_wallet_lower_idx ON games (lower(black_wallet));
CREATE INDEX IF NOT EXISTS users_wallet_lower_idx ON users (lower(wallet));
