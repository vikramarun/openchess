-- Two ladders: ranked and casual.
--
-- A game is RANKED when money was on it — a per-game USDC stake, or a pairing
-- in a tournament that charged a buy-in. Everything else (free park/gauntlet
-- games, free tournaments, anonymous engine-vs-engine) is CASUAL and moves the
-- separate ladder added at the bottom of this file.
--
-- Not to be confused with room.rs's `contested` gate (both sides made a move),
-- which decides WHETHER a rating moves at all. This flag decides WHICH one.
ALTER TABLE games ADD COLUMN IF NOT EXISTS rated BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill 1: a staked row is unambiguously ranked.
UPDATE games SET rated = TRUE WHERE stake IS NOT NULL AND stake > 0;

-- Backfill 2: so is a pairing in a buy-in tournament, even though the game
-- itself carries no stake (the pool settles separately). Every dispatched
-- pairing writes a tournament_games row and tournaments.buy_in has been
-- persisted since 0005, so history is recoverable here. The one gap: that write
-- is best-effort (`let _ = db.add_tournament_game(..)`), so a pairing whose row
-- never landed stays casual. Nothing else records the association, so that
-- residue is unrecoverable and accepted.
UPDATE games g SET rated = TRUE
  FROM tournament_games tg
  JOIN tournaments t ON t.id = tg.tournament_id
 WHERE g.id = tg.game_id
   AND t.buy_in IS NOT NULL;

-- The casual ladder. Same Elo math, same K, same 1500 seed, separate column.
--
-- Deliberately NOT seeded from users.rating: free games did move that column
-- before this migration, so a pre-existing wallet's ranked number carries
-- casual movement that cannot be unwound (nothing recorded the per-game
-- deltas). Forward-only, like the seat-wallet fix it follows.
ALTER TABLE users ADD COLUMN IF NOT EXISTS casual_rating REAL NOT NULL DEFAULT 1500;

-- 0007 indexed lower(white_wallet)/lower(black_wallet) for the profile reads.
-- Every one of those queries also filters status='finished', and now splits on
-- `rated` as well.
CREATE INDEX IF NOT EXISTS games_white_wallet_finished_rated_idx
  ON games (lower(white_wallet), rated) WHERE status = 'finished';
CREATE INDEX IF NOT EXISTS games_black_wallet_finished_rated_idx
  ON games (lower(black_wallet), rated) WHERE status = 'finished';
