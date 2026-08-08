-- The unsettled-games lookup filters on lower(white_addr)/lower(black_addr),
-- but 0007 only added functional indexes for the *_wallet columns — so that
-- query fell back to a sequential scan. Same class of miss that 0007 itself
-- fixed for the leaderboard; add the matching indexes for the seat columns.
CREATE INDEX IF NOT EXISTS games_white_addr_lower_idx ON games (lower(white_addr));
CREATE INDEX IF NOT EXISTS games_black_addr_lower_idx ON games (lower(black_addr));
