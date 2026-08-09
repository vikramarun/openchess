-- The last piece of a tournament that didn't survive a restart. Declared
-- engines are display-only (they gate nothing), but a rehydrated tournament
-- recorded no engine on its later games while the same entrants' park games
-- carried one — an inconsistency with no upside now that entrant_wallets
-- (0016) established the pattern.
ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS entrant_engines JSONB NOT NULL DEFAULT '{}'::jsonb;
