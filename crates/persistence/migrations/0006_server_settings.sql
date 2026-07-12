-- Small key/value store for durable server-wide switches (e.g. the owner-toggled
-- maintenance/drain flag). Survives restarts so an emergency pause set before a
-- deploy stays on until the owner explicitly lifts it.
CREATE TABLE IF NOT EXISTS server_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
