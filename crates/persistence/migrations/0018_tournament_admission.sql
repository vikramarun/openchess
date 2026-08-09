-- Who may join a tournament: 'open' (anyone), 'invite' (a single-use code the
-- organizer minted), or 'approval' (a wallet the organizer approved).
--
-- All three MUST be restored by `recover_tournaments`, for the same reason as
-- organizer (0012) and payout (0017), and with a sharper edge: a gated
-- tournament that rehydrated as 'open' is a closed door that silently stopped
-- existing, so the first person to try after a deploy walks straight into an
-- invite-only event. Losing `invites` would also re-open every code that had
-- already been spent.
--
-- Unlike a nominal entry fee — which is enforced by the chain, because N fake
-- entrants cost N x fee — these two are server policy living in this
-- single-node process. They are a door, not a vault.
ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS admission TEXT NOT NULL DEFAULT 'open';
-- {"<code>": "<entrant id>" | null}  — null while the code is unused.
ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS invites JSONB NOT NULL DEFAULT '{}'::jsonb;
-- {"<lowercased wallet>": "pending" | "approved" | "rejected"}
ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS approvals JSONB NOT NULL DEFAULT '{}'::jsonb;
