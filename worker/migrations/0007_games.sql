-- Games arcade — solo leaderboards (§6.1) and head-to-head records (§6.2/§6.3).
-- Spec: docs/active/specs/2026-08-30-games-arcade-design.md (youcoded-dev).
--
-- Both boards are FRIENDS-ONLY. Nothing here is a global ranking, so neither
-- table needs a public read path or an anti-cheat story (§6.4 accepts that
-- solo scores are client-reported and forgeable).

-- ---------------------------------------------------------------------------
-- Solo leaderboards: one row per (account, game), holding the BEST run only.
-- ---------------------------------------------------------------------------
-- §11 leaves "history vs best only" open, so this is deliberately shaped so a
-- later `game_runs` table can be added WITHOUT rewriting this one: every column
-- here is a property of the best run (or a counter), never of "the last run".
-- If history arrives, this table survives as the materialized best and the new
-- table holds the runs.
CREATE TABLE game_scores (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game TEXT NOT NULL,                      -- 'flappy' | 'twenty-forty-eight' (allowlisted in the route, not the schema)
  best_score INTEGER NOT NULL CHECK (best_score >= 0),
  best_at INTEGER NOT NULL,                -- unix seconds; when the BEST was set (ties rank by who got there first)
  runs INTEGER NOT NULL DEFAULT 0,         -- how many runs were submitted; the one history-ish fact that costs nothing
  updated_at INTEGER NOT NULL,             -- unix seconds; last submission of any kind
  PRIMARY KEY (user_id, game)
);
-- The board query filters by game and orders by (best_score DESC, best_at ASC).
-- SQLite can walk this index in that exact order, so the friends board needs no
-- sort step even once a user has many friends.
CREATE INDEX idx_game_scores_board ON game_scores(game, best_score DESC, best_at ASC);

-- ---------------------------------------------------------------------------
-- Head-to-head: one row per SETTLED MATCH, not per pair.
-- ---------------------------------------------------------------------------
-- WHY a match ledger instead of a wins/losses counter row per pair: the counter
-- shape has no way to tell a first report from a retry of the same report, so
-- a client that resends after a dropped socket would double-count. Keying the
-- row by the match makes the write idempotent BY CONSTRUCTION — an
-- INSERT OR IGNORE that loses is exactly a duplicate report. The "7-2 at chess"
-- number is then a GROUP BY over this table (see src/games/records.ts), which
-- also means there is no second copy of the count that can drift out of sync.
--
-- Volume is tiny (friends-only, a handful of matches per pair), so counting on
-- read is cheaper than maintaining a denormalized total.
CREATE TABLE game_matches (
  -- Canonical pair ordering, identical to `friendships` — pairKey() in
  -- src/social/graph.ts is the ONLY thing that produces these two columns, so
  -- one pair is one row and never two mirrored rows.
  user_low TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_high TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game TEXT NOT NULL,                      -- 'connect-four' | 'chess'
  -- The match's shared identity, supplied by both clients. In the shipping app
  -- this is the PartyKit room code both players already hold (the `code` on the
  -- challenge). Opaque to the worker — it only has to be the SAME string on
  -- both sides.
  match_id TEXT NOT NULL,
  winner TEXT REFERENCES users(id) ON DELETE CASCADE,   -- NULL = draw
  -- 'attested' = both clients reported and agreed (§6.2).
  -- 'forfeit'  = one client reported AND the presence room independently saw
  --              the other player's socket gone (§6.3).
  source TEXT NOT NULL CHECK (source IN ('attested', 'forfeit')),
  recorded_at INTEGER NOT NULL,            -- unix seconds
  PRIMARY KEY (user_low, user_high, game, match_id),
  CHECK (user_low < user_high),
  CHECK (winner IS NULL OR winner = user_low OR winner = user_high)
);
-- The records read walks both directions of the pair (a user is user_low for
-- some opponents and user_high for others), so both sides need an index.
CREATE INDEX idx_game_matches_low ON game_matches(user_low, game);
CREATE INDEX idx_game_matches_high ON game_matches(user_high, game);
