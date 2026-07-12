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

-- Defensive de-dup FIRST: by the invariant above there should be no duplicates,
-- but if a live DB somehow already holds two rows for one game_id, an unguarded
-- CREATE UNIQUE INDEX would fail and brick server boot. Collapse to one row per
-- game_id — preferring an already-'settled' row, else the newest — which is safe
-- because a duplicate would settle the same game idempotently (the contract's
-- replay guard + the worker's is_settled check make the dropped row a no-op).
DELETE FROM settlement_outbox
WHERE ctid NOT IN (
    SELECT DISTINCT ON (game_id) ctid
    FROM settlement_outbox
    ORDER BY game_id, (status = 'settled') DESC, created_at DESC, ctid DESC
);

CREATE UNIQUE INDEX IF NOT EXISTS settlement_outbox_game_id_uidx
    ON settlement_outbox (game_id);
