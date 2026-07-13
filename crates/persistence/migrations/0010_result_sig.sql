-- Persist the oracle's signature over a finished game's result commitment
-- (result_hash), so the permanent replay view (GET /games/{id}) can show the
-- same "✓ signed by oracle" verification the live/seat views show from the
-- game_over WS frame. Nullable: unwagered/legacy games may not carry one.
ALTER TABLE games ADD COLUMN IF NOT EXISTS result_sig TEXT;
