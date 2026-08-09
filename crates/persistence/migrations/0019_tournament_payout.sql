-- Creator-defined payout structure: basis points per finishing place, best
-- first. Until now the 65/25/10 split was hardcoded server-side, so there was
-- nothing to store.
--
-- This MUST be restored by `recover_tournaments` alongside buy_in/organizer
-- (migration 0012) and entrant_wallets (0016). An open tournament that
-- rehydrated with the default structure would pay its field something other
-- than what it was promised — and unlike the display-only columns, that failure
-- is silent, because the money still moves and the standings still look right.
--
-- The default reproduces the previous hardcoded behaviour, so rows written
-- before this column existed settle exactly as they would have.
ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS payout JSONB NOT NULL DEFAULT '{"bps":[6500,2500,1000]}'::jsonb;
