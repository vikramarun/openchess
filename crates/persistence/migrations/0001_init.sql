-- Durable source of truth: users, games, the signed move log, and wagers.
-- Ephemeral lobby/matchmaking state lives in the server (Redis in production).

CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY,
    wallet        TEXT UNIQUE NOT NULL,
    display_name  TEXT,
    rating        REAL NOT NULL DEFAULT 1500,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS games (
    id                 UUID PRIMARY KEY,
    mode               TEXT NOT NULL,                  -- park | gauntlet | tournament | casual
    status             TEXT NOT NULL,                  -- pending | active | finished | aborted
    white_wallet       TEXT,
    black_wallet       TEXT,
    time_initial_ms    BIGINT NOT NULL,
    time_increment_ms  BIGINT NOT NULL,
    -- on-chain seats / wager (null for unwagered games)
    white_addr         TEXT,
    black_addr         TEXT,
    stake              NUMERIC,
    -- result (null until finished)
    result             TEXT,                           -- white | black | draw
    result_reason      TEXT,
    result_hash        TEXT,
    pgn                TEXT,
    settlement_status  TEXT NOT NULL DEFAULT 'none',   -- none | pending | settled | failed
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS games_status_idx ON games (status);
CREATE INDEX IF NOT EXISTS games_created_idx ON games (created_at DESC);

CREATE TABLE IF NOT EXISTS moves (
    game_id    UUID NOT NULL REFERENCES games (id) ON DELETE CASCADE,
    ply        INT NOT NULL,
    uci        TEXT NOT NULL,
    san        TEXT NOT NULL,
    white_ms   BIGINT NOT NULL,
    black_ms   BIGINT NOT NULL,
    played_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (game_id, ply)
);
