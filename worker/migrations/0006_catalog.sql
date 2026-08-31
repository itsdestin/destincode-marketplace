-- Marketplace overhaul, Layer A (docs/active/specs/2026-08-28-marketplace-overhaul-ui-design.md §2):
-- the catalog the app reads. One row per listing; the full entry (index.json
-- fields + the `catalog` block) lives in entry_json so the schema never has to
-- chase the app's SkillEntry shape. The indexed columns are the ones the read
-- and retire queries filter on.
CREATE TABLE catalog_items (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,                -- wecoded | anthropic | docker | awesome-copilot | cursorrules
  item_type TEXT NOT NULL,             -- plugin | skill | specialist | tool | prompt
  part_of_id TEXT,                     -- bundle id for member rows
  deprecated INTEGER NOT NULL DEFAULT 0,
  source_commit TEXT,                  -- the commit whose FILES were scanned; drives the
                                       -- "only re-read what changed" skip in the ingest
  scan_rules TEXT,                     -- version of the rule set behind the stored verdict.
                                       -- The skip key is (commit, scan_rules), so bumping
                                       -- SCAN_RULES_VERSION re-scans the whole catalog by
                                       -- itself instead of waiting for a manual --force-rescan
                                       -- that nobody remembers to run.
  updated_at INTEGER NOT NULL,         -- last time the CONTENT changed — not "last seen"
  entry_json TEXT NOT NULL
);
-- There is deliberately NO run_id / "last touched" column. A row is written only when its
-- content changes (Task 6), and "still alive" is proven by the ingest's explicit retire list,
-- never by rewriting the row. Rewriting ~4,000 rows an hour to mark them seen would spend the
-- entire free-tier write budget (100,000 rows/day, index writes counted on top) on nothing.
--
-- (deprecated, id), not (deprecated) alone: GET /catalog walks the served rows in id order
-- by keyset (`WHERE deprecated = 0 AND id > ?`), and D1 bills rows SCANNED, not returned.
-- This is the only index on the table: every index is one more write per row change, and
-- nothing in this plan filters by part_of_id or item_type.
CREATE INDEX idx_catalog_served ON catalog_items(deprecated, id);

-- One row per (source, run). finished_at NULL = still running / crashed. Kept purely
-- for "did the ingest run, and what did it do" — nothing reads it to make a decision.
CREATE TABLE catalog_runs (
  id TEXT NOT NULL,
  source TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  upserted INTEGER NOT NULL DEFAULT 0,
  retired INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  PRIMARY KEY (id, source)
);
CREATE INDEX idx_catalog_runs_source ON catalog_runs(source, finished_at);

-- Exactly one row (id = 'v'). Every write to catalog_items bumps `version`, and that
-- number IS the ETag of GET /catalog.
--
-- This table is the difference between the catalog working and the catalog running out
-- of database quota in its first week. Without it, answering "nothing has changed" means
-- reading every catalog row to compute the ETag first — so the cheap reply costs exactly
-- as much as sending the whole 5,000-row payload. D1's free tier allows 5 M row-reads a
-- day; at one full read per client refresh that is a few hundred refreshes a day for the
-- entire user base. With it, an unchanged reply reads ONE row.
CREATE TABLE catalog_meta (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO catalog_meta (id, version, updated_at) VALUES ('v', 1, 0);
