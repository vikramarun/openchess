-- Idempotency backstop for the settlement outbox.
--
-- Today, double-settlement is prevented by the status-transition guard in
-- finish_and_enqueue (a single transactional writer: the outbox row is inserted
-- only when the game flips to 'finished', guarded by status NOT IN
-- ('finished','aborted')), plus the escrow's on-chain replay guard and the
-- worker's is_settled check. That's correct now, but there is no DB-level
-- guarantee — any future second enqueue path would double-pay a winner, with
-- only the on-chain replay guard as a backstop.
--
-- One outbox row per game is an invariant of the current code, so a UNIQUE index
-- is safe and makes a stray second enqueue fail loudly (a caught DB error)
-- instead of silently paying twice.
CREATE UNIQUE INDEX IF NOT EXISTS settlement_outbox_game_id_uidx
    ON settlement_outbox (game_id);
