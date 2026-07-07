-- Accounts substrate rebuild (spec 2026-07-03 §1). Clean rebuild, not additive:
-- user base is ~4, so we take the best long-term schema with zero compat shims.
-- Every existing user gets a fresh opaque account id; provider data moves to
-- `identities`; sessions are dropped (each client signs in again once).
-- THIS FILE is the only place the legacy 'github:<id>' format is ever parsed.

-- 1) Old-id → new-id mapping for the FK remaps below.
CREATE TABLE id_map (
  old_id TEXT PRIMARY KEY,
  new_id TEXT NOT NULL UNIQUE
);
INSERT INTO id_map (old_id, new_id)
  SELECT id, 'acct_' || lower(hex(randomblob(16))) FROM users;

-- 2) Account table: opaque PK, no provider columns, tier-C stubs.
CREATE TABLE users_v2 (
  id TEXT PRIMARY KEY,                      -- 'acct_' + 32 hex; opaque, never parsed
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  handle TEXT,                              -- nullable; unique via index below
  status TEXT NOT NULL DEFAULT 'active',    -- tier-C stub: 'active' | 'suspended'
  created_at INTEGER NOT NULL,              -- unix seconds
  deleted_at INTEGER                        -- tier-C stub; user deletion is hard delete
);
INSERT INTO users_v2 (id, display_name, avatar_url, created_at)
  SELECT m.new_id, u.github_login, u.github_avatar_url, u.created_at
  FROM users u JOIN id_map m ON m.old_id = u.id;

-- 3) Provider identities: one account, N providers.
CREATE TABLE identities (
  provider TEXT NOT NULL,                   -- 'github' (later 'google')
  provider_user_id TEXT NOT NULL,           -- GitHub numeric id as text / Google sub
  user_id TEXT NOT NULL REFERENCES users_v2(id) ON DELETE CASCADE,
  provider_login TEXT,
  linked_at INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_user_id)
);
-- Backfill: legacy ids are 'github:<numeric>'; substr(id, 8) strips 'github:'.
INSERT INTO identities (provider, provider_user_id, user_id, provider_login, linked_at)
  SELECT 'github', substr(u.id, 8), m.new_id, u.github_login, u.created_at
  FROM users u JOIN id_map m ON m.old_id = u.id;

-- 4) Handle cooldown ledger (30 days; spec §2) — written on rename + deletion.
CREATE TABLE handle_releases (
  handle TEXT PRIMARY KEY,
  released_at INTEGER NOT NULL
);

-- 5) Rebuild FK tables against users_v2 with remapped ids.
--    Sessions are intentionally NOT migrated (drop-all: users re-sign-in once).
CREATE TABLE sessions_v2 (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users_v2(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);

CREATE TABLE installs_v2 (
  user_id TEXT NOT NULL REFERENCES users_v2(id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL,
  installed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, plugin_id)
);
INSERT INTO installs_v2
  SELECT m.new_id, i.plugin_id, i.installed_at
  FROM installs i JOIN id_map m ON m.old_id = i.user_id;

CREATE TABLE ratings_v2 (
  user_id TEXT NOT NULL REFERENCES users_v2(id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL,
  stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5),
  review_text TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, plugin_id)
);
INSERT INTO ratings_v2
  SELECT m.new_id, r.plugin_id, r.stars, r.review_text, r.created_at, r.updated_at, r.hidden
  FROM ratings r JOIN id_map m ON m.old_id = r.user_id;

CREATE TABLE theme_likes_v2 (
  user_id TEXT NOT NULL REFERENCES users_v2(id) ON DELETE CASCADE,
  theme_id TEXT NOT NULL,
  liked_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, theme_id)
);
INSERT INTO theme_likes_v2
  SELECT m.new_id, t.theme_id, t.liked_at
  FROM theme_likes t JOIN id_map m ON m.old_id = t.user_id;

CREATE TABLE reports_v2 (
  id TEXT PRIMARY KEY,
  rating_user_id TEXT NOT NULL,             -- loose ref (no FK), matches v1
  rating_plugin_id TEXT NOT NULL,
  reporter_user_id TEXT NOT NULL REFERENCES users_v2(id) ON DELETE CASCADE,
  reason TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolution TEXT
);
INSERT INTO reports_v2
  SELECT r.id, coalesce(m1.new_id, r.rating_user_id), r.rating_plugin_id,
         m2.new_id, r.reason, r.created_at, r.resolved_at, r.resolution
  FROM reports r
  LEFT JOIN id_map m1 ON m1.old_id = r.rating_user_id
  JOIN id_map m2 ON m2.old_id = r.reporter_user_id;

-- 6) device_codes: drop in-flight rows (15-min TTL anyway) and the dead
--    session_token_hash column (unwritten since the poll-time-issuance change).
DROP TABLE device_codes;
CREATE TABLE device_codes (
  device_code TEXT PRIMARY KEY,
  user_code TEXT NOT NULL,
  csrf_state TEXT,
  authorized_user_id TEXT,                  -- account id once callback completes
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- 7) Swap: drop old tables first (frees the index names), then rename and index.
DROP TABLE sessions;
DROP TABLE installs;
DROP TABLE ratings;
DROP TABLE theme_likes;
DROP TABLE reports;
DROP TABLE users;
DROP TABLE id_map;

ALTER TABLE users_v2 RENAME TO users;
ALTER TABLE sessions_v2 RENAME TO sessions;
ALTER TABLE installs_v2 RENAME TO installs;
ALTER TABLE ratings_v2 RENAME TO ratings;
ALTER TABLE theme_likes_v2 RENAME TO theme_likes;
ALTER TABLE reports_v2 RENAME TO reports;

CREATE UNIQUE INDEX idx_users_handle ON users(handle);
CREATE INDEX idx_identities_user ON identities(user_id);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_installs_plugin ON installs(plugin_id);
CREATE INDEX idx_ratings_plugin_visible ON ratings(plugin_id) WHERE hidden = 0;
CREATE INDEX idx_reports_open ON reports(created_at) WHERE resolved_at IS NULL;
CREATE INDEX idx_device_codes_user_code ON device_codes(user_code);
