-- Paid joins that have not (yet) been confirmed as seated: wallets for which
-- the server began an onchain `enterTournament` and has not since seated in
-- the field, each with the seat its join asked for:
-- {"<lowercased wallet>": {"bot": bool, "uci_options": [[k, v], ...], "engine": str|null}}
--
-- The entry is recorded HERE, durably, BEFORE the buy-in moves, because every
-- way a paid join can fail after that point leaves money in the pool with no
-- seat: the read-back of a landed transaction keeps failing, the client
-- disconnects mid-transaction, the process restarts, or the entry lands after
-- the organizer started the event. The payout divides the ONCHAIN pool across
-- the OFF-CHAIN field, so an unseated payer's buy-in used to go to everyone
-- else. `tourney_start` seats any recorded wallet the chain confirms paid, and
-- settlement refunds any still unseated. Must be restored by
-- `recover_tournaments`, or a restart forgets who paid.
ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS unconfirmed_entries JSONB NOT NULL DEFAULT '{}'::jsonb;
