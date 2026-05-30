-- Transactional settlement outbox: a finished wagered game enqueues a row; a
-- worker drains it and settles on-chain. Survives crashes/restarts; at-least-
-- once delivery is safe because the escrow contract is replay-guarded.

CREATE TABLE IF NOT EXISTS settlement_outbox (
    id           UUID PRIMARY KEY,
    game_id      UUID NOT NULL,
    winner_addr  TEXT,                              -- null = draw
    status       TEXT NOT NULL DEFAULT 'pending',   -- pending | processing | settled | failed
    attempts     INT NOT NULL DEFAULT 0,
    last_error   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS settlement_outbox_pending_idx
    ON settlement_outbox (status)
    WHERE status = 'pending';
