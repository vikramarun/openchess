-- Durable outbox for TOURNAMENT settlement (parallels settlement_outbox for
-- per-game results). A completed tournament enqueues its computed payout here;
-- a worker drains it on-chain. At-least-once is safe — the escrow is replay-
-- guarded and the worker treats an already-settled tournament as success.
CREATE TABLE IF NOT EXISTS tournament_outbox (
    id          UUID PRIMARY KEY,
    tid         UUID NOT NULL,
    mode        TEXT NOT NULL,          -- direct | root
    payload     JSONB NOT NULL,         -- {winners,payouts} | {leaves:[[addr,amount]]}
    status      TEXT NOT NULL DEFAULT 'pending',  -- pending | processing | settled | failed
    attempts    INT NOT NULL DEFAULT 0,
    last_error  TEXT,
    claimed_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tournament_outbox_pending_idx
    ON tournament_outbox (status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS tournament_outbox_tid_idx ON tournament_outbox (tid);
