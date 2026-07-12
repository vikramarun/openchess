-- Tournament display name, persisted so the per-wallet "claimable tournaments"
-- endpoint can label payouts/refunds from Postgres alone — the in-memory
-- tournaments map is NOT rehydrated on restart, so the claim UI can't rely on
-- GET /tournaments (which serves that map).
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '';
