-- Durable tournament state so a server restart can re-derive standings and
-- settle by result (rather than only refunding). Live scoring is reconstructed
-- from each game's persisted result.
CREATE TABLE IF NOT EXISTS tournaments (
    id              UUID PRIMARY KEY,
    buy_in          TEXT,                   -- USDC base units; null = casual
    initial_secs    BIGINT NOT NULL,
    increment_secs  BIGINT NOT NULL,
    status          TEXT NOT NULL,          -- open | running | complete | settled | abandoned
    players         JSONB NOT NULL DEFAULT '[]',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tournament_games (
    tournament_id  UUID NOT NULL REFERENCES tournaments (id) ON DELETE CASCADE,
    game_id        UUID NOT NULL,
    white          TEXT NOT NULL,           -- entrant label/address for the white seat
    black          TEXT NOT NULL,
    PRIMARY KEY (game_id)
);
CREATE INDEX IF NOT EXISTS tournament_games_tid_idx ON tournament_games (tournament_id);
