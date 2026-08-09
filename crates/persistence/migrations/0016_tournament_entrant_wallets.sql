-- Casual (free) tournament entrants are identified by display name, so their
-- finished games recorded no wallet — a signed-in human in a free tournament
-- got no history row and no casual Elo, while a bot entrant in the same
-- tournament (whose wallet rides its agent registration) did. The name→wallet
-- map now persists with the tournament so games dispatched after a restart
-- stay attributed (same reasoning as `bots` in 0012).
ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS entrant_wallets JSONB NOT NULL DEFAULT '{}'::jsonb;
