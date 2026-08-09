-- Everything an `open` tournament needs to be rebuilt in memory after a restart.
--
-- Until now only `running` tournaments were looked at on boot (to abandon them),
-- so an `open` tournament simply vanished from the lobby when the server
-- restarted — while its on-chain pool stayed open and every entrant's buy-in
-- stayed locked. Rehydrating needs two things the row didn't carry: who may
-- start it, and which entrants are played by a connected agent.
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS organizer TEXT;
-- {"<player id>": {"wallet": "0x…", "uci_options": [["k","v"], …]}, …}
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS bots JSONB NOT NULL DEFAULT '{}';
