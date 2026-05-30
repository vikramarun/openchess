-- Lease timestamp so a worker crash between claim and complete can be detected
-- and the stranded `processing` row requeued.
ALTER TABLE settlement_outbox ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
