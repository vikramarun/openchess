-- Profile photos, stored inline in Postgres rather than in object storage: this
-- deployment has no blob store, and an avatar is bounded hard on the way in
-- (the server caps the body at 256 KiB and the web client downsizes to a 256px
-- square first), so the column stays small enough to live next to the user row.
-- `avatar_updated_at` is the cache-busting version the profile API hands the
-- client, so a replaced photo is not served from the old cached response.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_mime       TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_data       BYTEA;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_updated_at TIMESTAMPTZ;
