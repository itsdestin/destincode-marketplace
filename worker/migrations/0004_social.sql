-- Accounts Phase 2 (spec §2): friend graph, pending friend requests, blocks,
-- and the single persisted presence fact (users.last_seen_at — spec §5 invariant:
-- NO presence history, only the most recent timestamp).

-- One canonical row per friend pair; symmetric by definition.
CREATE TABLE friendships (
  user_low TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_high TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,             -- unix seconds
  PRIMARY KEY (user_low, user_high),
  CHECK (user_low < user_high)
);
CREATE INDEX idx_friendships_high ON friendships(user_high);

-- Pending requests ONLY: accept/decline/cancel delete the row (accept also
-- creates the friendship in the same batch). No resolution history stored.
CREATE TABLE friend_requests (
  id TEXT PRIMARY KEY,                     -- 'freq_' + 32 hex; opaque
  from_user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  UNIQUE (from_user, to_user)              -- one pending request per direction per pair
);
CREATE INDEX idx_friend_requests_to ON friend_requests(to_user);

-- Block list visible only to its owner. Block beats friend everywhere.
CREATE TABLE blocks (
  blocker TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker, blocked)
);
CREATE INDEX idx_blocks_blocked ON blocks(blocked);

-- Friends-visible "last seen" — written by the PresenceRoom DO on disconnect
-- and on a coarse ~5-minute refresh. Nullable: never-connected users have none.
ALTER TABLE users ADD COLUMN last_seen_at INTEGER;

-- Who released a handle: lets the PREVIOUS OWNER re-claim their own handle
-- during the 30-day cooldown (Destin, 2026-07-08: renames shouldn't lock you
-- out of your old handle). NULL = nobody can reclaim early. ON DELETE SET NULL
-- so a deleted account's handles follow the normal cooldown for everyone.
ALTER TABLE handle_releases ADD COLUMN released_by TEXT REFERENCES users(id) ON DELETE SET NULL;
