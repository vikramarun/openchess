-- Record which engine played each seat.
--
-- The self-declared engine string already existed, but only in memory: it rode
-- along on the in-process `live_games` map and in WS frames, so it vanished the
-- moment a game finished. A finished game's replay had no way to show what
-- actually played it, which is most of the point of letting people pick a
-- repertoire.
--
-- Nullable, because every game recorded before this migration has no engine,
-- and because a seat is never required to declare one. Informational only —
-- unverified by design (see ARCHITECTURE.md's trust model), so nothing on the
-- money path may ever branch on it.
ALTER TABLE games ADD COLUMN IF NOT EXISTS white_engine TEXT;
ALTER TABLE games ADD COLUMN IF NOT EXISTS black_engine TEXT;
