-- Marketplace overhaul (spec docs/active/specs/2026-08-28-marketplace-overhaul-ui-design.md §1.7):
-- one-tap Helpful / Not for me votes and an open comment thread replace star
-- reviews. Ratings stay in place (rows are orphaned, not migrated — there are
-- almost none; ROADMAP carries the cleanup).
--
-- thumbs: one row per (user, plugin); vote is +1 (helpful) or -1 (not for me).
-- Clearing a vote DELETEs the row. Install-gated in the route, not the schema —
-- and honest about what that buys: POST /installs accepts any string as a
-- plugin_id with no existence check, so the gate stops a drive-by, not a
-- determined actor. Plan 2's catalog_items check is what makes it a real gate.
CREATE TABLE thumbs (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL,
  vote INTEGER NOT NULL CHECK(vote IN (1, -1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, plugin_id)
);
-- Serves both the per-plugin totals in GET /stats and the single-plugin totals
-- POST /thumbs returns with its own write.
CREATE INDEX idx_thumbs_plugin ON thumbs(plugin_id);

-- comments: many per user per plugin (a thread, not a review). `hidden` is set
-- by the llama-guard classifier exactly like ratings.hidden; hidden rows are
-- stored but never listed, and an admin can set it later via
-- DELETE /admin/comments/:id. Partial index mirrors idx_ratings_plugin_visible.
CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_comments_plugin_visible ON comments(plugin_id, created_at) WHERE hidden = 0;
-- The admin takedown queue reads by `hidden` alone (newest first), which the
-- partial index above cannot serve — it excludes exactly the rows that queue
-- exists to show.
CREATE INDEX idx_comments_hidden ON comments(hidden, created_at);
