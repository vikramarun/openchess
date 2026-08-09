-- Usernames: a wallet's public handle, unique case-insensitively, with its
-- display case preserved.
--
-- The wallet stays the only identity that survives a game
-- (games.white_wallet/black_wallet). A username is a label resolved live at
-- render time and never copied into a game row, so a rename does not rewrite
-- history and a freed name does not orphan anything.
--
-- Three parts, and the first is a prerequisite rather than housekeeping:
--
-- 1. `users` could hold TWO rows for one wallet. `upsert_user` conflicts on the
--    raw `wallet` UNIQUE from 0001 while `set_avatar` inserts a lowercased one,
--    and a wagered game reaches `upsert_user` with an EIP-55 CHECKSUMMED address
--    (alloy's Address Display, via seat_wallets). Every read folds through
--    lower(wallet) with fetch_optional, so the fork was survivable — it silently
--    picked a row. A username cannot survive it: the name would be written to
--    one row and read from the other. So merge the twins, canonicalise to
--    lowercase, and make a third one structurally impossible.
-- 2. The handle itself, nullable — most wallets never set one, and NULL is also
--    what "never renamed" means to the 7-day cooldown.
-- 3. Uniqueness on lower(username), plus a prefix index the typeahead can
--    actually use. A plain btree is useless to LIKE 'x%' under a non-C
--    collation; text_pattern_ops is what makes the search an index scan instead
--    of a seq scan of `users` on every keystroke.
--
-- Note on a deliberate product choice, recorded here because the next person
-- will wonder: a released username is freed IMMEDIATELY, so a name someone
-- drops can be claimed seconds later and stale links then point at a stranger.
-- If that ever needs to change, the fix is a `username_history` table with a
-- grace period, not a change to the columns below.

-- 1a. Merge duplicate wallet rows: keep the oldest, adopt whatever the newer
--     twin held. No FK anywhere references users.id (the only REFERENCES in this
--     directory are games(id) and tournaments(id)), so deleting the loser is a
--     local operation. COALESCE/GREATEST are chosen so this cannot lose a photo
--     or a rating.
WITH ranked AS (
  SELECT id, lower(wallet) AS k,
         row_number() OVER (PARTITION BY lower(wallet) ORDER BY created_at, id) AS rn
  FROM users
),
keep AS (SELECT id, k FROM ranked WHERE rn = 1),
dead AS (SELECT id, k FROM ranked WHERE rn > 1),
merged AS (
  UPDATE users u SET
    avatar_mime       = COALESCE(u.avatar_mime,       d.avatar_mime),
    avatar_data       = COALESCE(u.avatar_data,       d.avatar_data),
    avatar_updated_at = COALESCE(u.avatar_updated_at, d.avatar_updated_at),
    rating            = GREATEST(u.rating,        d.rating),
    casual_rating     = GREATEST(u.casual_rating, d.casual_rating)
  FROM keep k
  JOIN dead dd ON dd.k = k.k
  JOIN users d ON d.id = dd.id
  WHERE u.id = k.id
  RETURNING u.id
)
DELETE FROM users WHERE id IN (SELECT id FROM dead);

-- 1b. Canonicalise. Safe now: no lowercase twin is left to collide with.
UPDATE users SET wallet = lower(wallet) WHERE wallet <> lower(wallet);

-- 1c. The structural guarantee. `upsert_user` still conflicts on the raw
--     `wallet` UNIQUE from 0001; this index is what makes a mixed-case insert
--     FAIL LOUDLY instead of quietly forking the row again. The same commit
--     lowercases upsert_user's bind so nothing hits it in practice.
CREATE UNIQUE INDEX IF NOT EXISTS users_wallet_lower_uidx ON users (lower(wallet));

-- 2. The handle.
ALTER TABLE users ADD COLUMN IF NOT EXISTS username            TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS username_updated_at TIMESTAMPTZ;

-- 3a. Uniqueness is case-insensitive; storage is case-preserving. This index is
--     the ONLY thing that makes a concurrent claim atomic — any check-then-write
--     in a handler is a TOCTOU by construction, so the collision has to be
--     decided by the constraint, not by the check.
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_uidx ON users (lower(username));

-- 3b. Prefix search for the typeahead. See the header.
CREATE INDEX IF NOT EXISTS users_username_prefix_idx
  ON users (lower(username) text_pattern_ops);

-- 4. Dead since 0001: nothing has ever read or written it. Dropped now so nobody
--    later mistakes it for the column above.
ALTER TABLE users DROP COLUMN IF EXISTS display_name;
