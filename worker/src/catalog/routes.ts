// Catalog — Layer A of the marketplace overhaul (spec §2). Serve side of the
// ingest job in scripts/catalog/. Rows are whole SkillEntry objects; the app
// renders entry.catalog untouched.
import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { requireIngestToken } from "./auth";
import { badRequest } from "../lib/errors";
import { parseJsonBody } from "../lib/parse-json";
import { requireAuth } from "../auth/middleware";
import { requireAdminAccount } from "../auth/admin";

export const catalogRoutes = new Hono<HonoEnv>();

const SOURCES = new Set(["wecoded", "anthropic", "docker", "awesome-copilot", "cursorrules"]);
const MAX_BATCH = 500;
/** Same bound as validateId (lib/validate.ts), so every stored id can be read back through
 *  GET /catalog/:id. */
const MAX_ID = 128;
/** D1 allows at most 100 bound parameters per statement — every `IN (…)` below chunks at this. */
const IN_CHUNK = 100;
/** A `finish` may never delist more than this share of a source's live rows in one run —
 *  a long retire list is a broken scrape, not a bulk deletion. Sources with fewer than
 *  RETIRE_GUARD_FLOOR live rows are exempt (a ratio is meaningless at that size). */
export const MAX_RETIRE_FRACTION = 0.2;
export const RETIRE_GUARD_FLOOR = 10;

interface IngestCatalog {
  itemType?: string;
  partOf?: { id?: string };
  scan?: { status?: string; checkedAt?: string; findings?: string[]; rules?: string };
  capabilities?: unknown[];
  license?: string;
  sourceCommit?: string;
  stars?: number;
  upstreamId?: string;
  [k: string]: unknown;
}
interface IngestEntry {
  id?: string;
  deprecated?: boolean;
  publishedAt?: string;
  catalog?: IngestCatalog;
  [k: string]: unknown;
}

// THE MERGE RULE (rule 1). An ingest run that could not read a repo's files is not
// evidence that the repo became unsafe, and a run that ran out of GitHub budget is not
// evidence that a licence vanished — so a field the incoming row does not state keeps
// whatever is already on file, and an "unchecked" scan never overwrites a real one.
// Consequence: a degraded run merges back to what was stored, and the write-skip below
// then writes nothing at all.
//
// Key order matters for the write-skip: the STORED object is spread first, so an
// unchanged row serialises to the same bytes it was stored as.
const SCAN_RANK: Record<string, number> = { unchecked: 0, checked: 1, caution: 1 };
function mergeOntoStored(incoming: IngestEntry, storedJson: string | null, nowIso: string): IngestEntry {
  if (!storedJson) return incoming.publishedAt ? incoming : { ...incoming, publishedAt: nowIso };
  let stored: IngestEntry;
  try { stored = JSON.parse(storedJson) as IngestEntry; } catch { return incoming; }
  const a = incoming.catalog ?? {};
  const b = stored.catalog ?? {};
  const merged: IngestCatalog = { ...b, ...a };
  for (const k of ["license", "sourceCommit", "stars", "upstreamId"] as const) {
    if (a[k] === undefined && b[k] !== undefined) (merged as Record<string, unknown>)[k] = b[k];
  }
  // `b.scan &&` is not just a type guard: a higher stored rank can only come from a
  // stored scan that exists, so this can never skip a downgrade we meant to block.
  if (b.scan && (SCAN_RANK[a.scan?.status ?? "unchecked"] ?? 0) < (SCAN_RANK[b.scan.status ?? "unchecked"] ?? 0)) {
    merged.scan = b.scan;                                    // keep the real verdict AND its age
  }
  if (!a.capabilities?.length && b.capabilities?.length) merged.capabilities = b.capabilities;
  const out: IngestEntry = { ...stored, ...incoming, catalog: merged };
  if (!incoming.publishedAt && stored.publishedAt) out.publishedAt = stored.publishedAt;
  return out;
}

async function ensureRun(db: D1Database, runId: string, source: string, now: number): Promise<void> {
  await db.prepare("INSERT OR IGNORE INTO catalog_runs (id, source, started_at) VALUES (?, ?, ?)")
    .bind(runId, source, now).run();
}

/** The ETag of GET /catalog is this number. Bumped by every write that changes what a
 *  client would receive — never by a no-op hour, so an unchanged catalog keeps every
 *  client's cached copy valid. */
async function bumpCatalogVersion(db: D1Database, now: number): Promise<void> {
  await db.prepare("UPDATE catalog_meta SET version = version + 1, updated_at = ? WHERE id = 'v'").bind(now).run();
}

/** The current catalog version — one row, and the whole reason a "nothing changed"
 *  reply is cheap. */
async function readVersion(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT version FROM catalog_meta WHERE id = 'v'").first<{ version: number }>();
  return row?.version ?? 0;
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

catalogRoutes.post("/admin/catalog/upsert", requireIngestToken, async (c) => {
  const body = await parseJsonBody<{ source?: string; run_id?: string; entries?: IngestEntry[] }>(c);
  if (!body.source || !SOURCES.has(body.source)) throw badRequest("unknown source");
  if (!body.run_id || body.run_id.length > 64) throw badRequest("invalid run_id");
  if (!Array.isArray(body.entries) || body.entries.length === 0) throw badRequest("entries must be a non-empty array");
  if (body.entries.length > MAX_BATCH) throw badRequest(`at most ${MAX_BATCH} entries per request`);
  const now = Math.floor(Date.now() / 1000);
  const nowIso = new Date(now * 1000).toISOString();
  await ensureRun(c.env.DB, body.run_id, body.source, now);

  for (const raw of body.entries) {
    if (typeof raw.id !== "string" || !raw.id || raw.id.length > MAX_ID) throw badRequest("entry without a valid id");
    if (!raw.catalog || typeof raw.catalog.itemType !== "string") throw badRequest(`entry ${raw.id} has no catalog.itemType`);
  }

  // Read the stored JSON for this batch's ids up front — one query per 100 ids (the D1
  // parameter cap), not one per row — because the merge AND the write-skip both need it.
  const stored = new Map<string, string>();
  for (const ids of chunks(body.entries.map((e) => e.id as string), IN_CHUNK)) {
    const { results } = await c.env.DB
      .prepare(`SELECT id, entry_json FROM catalog_items WHERE id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids).all<{ id: string; entry_json: string }>();
    for (const r of results) stored.set(r.id, r.entry_json);
  }

  const stmt = c.env.DB.prepare(
    `INSERT INTO catalog_items (id, source, item_type, part_of_id, deprecated, source_commit, scan_rules, updated_at, entry_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET source = excluded.source, item_type = excluded.item_type,
       part_of_id = excluded.part_of_id, deprecated = excluded.deprecated,
       source_commit = excluded.source_commit, scan_rules = excluded.scan_rules,
       updated_at = excluded.updated_at, entry_json = excluded.entry_json`
  );
  let unchanged = 0;
  const batch: D1PreparedStatement[] = [];
  for (const raw of body.entries) {
    const e = mergeOntoStored(raw, stored.get(raw.id as string) ?? null, nowIso);
    const json = JSON.stringify(e);
    // THE WRITE-SKIP (rule 3). Same bytes as stored → no write, no version bump. This is
    // what keeps an hourly job that re-sends ~1,200 Docker/copilot rows inside D1's
    // 100,000 row-writes/day. A row that was retired and has reappeared always differs
    // (deprecated flips), so revival still writes.
    if (json === stored.get(raw.id as string)) { unchanged++; continue; }
    // scan_rules comes off the MERGED entry, so a run that kept a stored verdict also
    // keeps the rule version that produced it.
    batch.push(stmt.bind(e.id, body.source, e.catalog!.itemType, e.catalog!.partOf?.id ?? null, e.deprecated ? 1 : 0,
      e.catalog!.sourceCommit ?? null, e.catalog!.scan?.rules ?? null, now, json));
  }
  if (batch.length) {
    await c.env.DB.batch(batch);
    await c.env.DB.prepare("UPDATE catalog_runs SET upserted = upserted + ? WHERE id = ? AND source = ?")
      .bind(batch.length, body.run_id, body.source).run();
    await bumpCatalogVersion(c.env.DB, now);
  }
  return c.json({ ok: true, upserted: batch.length, unchanged });
});

catalogRoutes.post("/admin/catalog/finish", requireIngestToken, async (c) => {
  const body = await parseJsonBody<{ source?: string; run_id?: string; retire?: unknown; note?: string; allow_mass_retire?: boolean }>(c);
  if (!body.source || !SOURCES.has(body.source)) throw badRequest("unknown source");
  if (!body.run_id) throw badRequest("invalid run_id");
  if (!Array.isArray(body.retire) || !body.retire.every((x) => typeof x === "string" && x.length > 0 && x.length <= MAX_ID)) {
    throw badRequest("retire must be an array of ids");
  }
  const ids = [...new Set(body.retire as string[])];
  const now = Math.floor(Date.now() / 1000);
  await ensureRun(c.env.DB, body.run_id, body.source, now);

  // The retire guard. Count first, delist second: a long list is a broken scrape, not
  // 245 deletions. See the Interfaces note above.
  const counts = await c.env.DB
    .prepare("SELECT COUNT(*) AS live FROM catalog_items WHERE source = ? AND deprecated = 0")
    .bind(body.source).first<{ live: number }>();
  const live = counts?.live ?? 0;
  const wouldRetire = ids.length;
  if (!body.allow_mass_retire && live >= RETIRE_GUARD_FLOOR && wouldRetire > live * MAX_RETIRE_FRACTION) {
    const note = `refused: would retire ${wouldRetire} of ${live} live rows`;
    await c.env.DB.prepare("UPDATE catalog_runs SET finished_at = ?, retired = 0, note = ? WHERE id = ? AND source = ?")
      .bind(now, note, body.run_id, body.source).run();
    return c.json({ ok: true, retired: 0, refused: { wouldRetire, live } });
  }

  // Retire the listed ids — of THIS source only, so a mistaken id can never reach across.
  // Rows keep their JSON so a listing that vanished upstream can be revived by a later
  // upsert (deprecated flips back to 0, which the write-skip sees as a change).
  let retired = 0;
  for (const part of chunks(ids, IN_CHUNK)) {
    const r = await c.env.DB
      .prepare(`UPDATE catalog_items SET deprecated = 1, updated_at = ? WHERE source = ? AND deprecated = 0 AND id IN (${part.map(() => "?").join(",")})`)
      .bind(now, body.source, ...part).run();
    retired += r.meta.changes ?? 0;
  }
  await c.env.DB.prepare("UPDATE catalog_runs SET finished_at = ?, retired = ?, note = ? WHERE id = ? AND source = ?")
    .bind(now, retired, body.note ?? null, body.run_id, body.source).run();
  if (retired) await bumpCatalogVersion(c.env.DB, now);
  return c.json({ ok: true, retired });
});

// What the catalog already holds for a source: EVERY live id, valued "<commit>:<rules>".
// Two consumers. The sources compare the value against their current skip key and do not
// re-download an unchanged repo (the ~6,000-fetch hour becomes a few dozen). build.mjs
// uses the KEY SET as "what exists", subtracts what the run sent or skipped, and sends the
// remainder to `finish` as the retire list — which is why every live id must be here,
// commit or no commit.
//
// The value is `<commit>:<scanRulesVersion>`, not a bare commit. A repo that has not
// moved but was scanned by an OLDER rule set is NOT up to date, and the ingest must
// re-read it. That is what makes "improve the scanner" a one-line version bump instead
// of a manual full rescan someone has to remember.
//
// Keyset, not OFFSET — the same reason as GET /catalog: OFFSET re-scans everything it
// skips, so paging 5,000 rows in blocks of 1,000 bills ~15,000 row-reads, not 5,000.
catalogRoutes.get("/admin/catalog/shas", requireIngestToken, async (c) => {
  const source = c.req.query("source") ?? "";
  if (!SOURCES.has(source)) throw badRequest("unknown source");
  const shas: Record<string, string> = {};
  let after = "";
  for (;;) {
    const { results } = await c.env.DB
      .prepare("SELECT id, source_commit, scan_rules FROM catalog_items WHERE source = ? AND deprecated = 0 AND id > ? ORDER BY id LIMIT 1000")
      .bind(source, after)
      .all<{ id: string; source_commit: string | null; scan_rules: string | null }>();
    for (const r of results) shas[r.id] = `${r.source_commit ?? ""}:${r.scan_rules ?? ""}`;
    if (results.length < 1000) break;
    after = results[results.length - 1]!.id;
  }
  return c.json({ shas });
});

// "Is the catalog still being fed?" — the one question no error message ever answers,
// because a stalled ingest fails silently: the rows just stop changing. Admin-gated
// (same identity check as /admin/analytics/*), read-only, cheap.
catalogRoutes.get("/admin/catalog/health", requireAuth, async (c) => {
  await requireAdminAccount(c);
  const meta = await c.env.DB.prepare("SELECT version, updated_at FROM catalog_meta WHERE id = 'v'")
    .first<{ version: number; updated_at: number }>();
  const { results } = await c.env.DB.prepare(
    `SELECT i.source AS source,
            COUNT(*) AS live,
            (SELECT MAX(finished_at) FROM catalog_runs r WHERE r.source = i.source) AS lastFinishedAt,
            (SELECT r.retired FROM catalog_runs r WHERE r.source = i.source ORDER BY r.finished_at DESC LIMIT 1) AS lastRetired,
            (SELECT r.note FROM catalog_runs r WHERE r.source = i.source ORDER BY r.finished_at DESC LIMIT 1) AS lastNote
     FROM catalog_items i WHERE i.deprecated = 0 GROUP BY i.source ORDER BY i.source`
  ).all();
  return c.json({ version: meta?.version ?? 0, updatedAt: meta?.updated_at ?? 0, sources: results });
});
