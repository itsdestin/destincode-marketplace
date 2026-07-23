// Privacy-by-construction contract: every query in this file aggregates
// device_id (blob2) via count(DISTINCT) or omits it from SELECT entirely.
// Raw device_id_hashes never leave the Worker — don't add a route that
// returns them, even for debugging.
//
// SQL dialect: Cloudflare Analytics Engine uses a narrow SQL subset — NOT
// full ClickHouse. Quirks learned the hard way (422 responses):
// - Cardinality is `count(DISTINCT col)`. ClickHouse's `uniq()` is rejected.
// - `INTERVAL '30' DAY` — count must be a QUOTED STRING LITERAL.
// - `count()` alone works; use `count(DISTINCT col)` for cardinality.
// See: https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/
import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { requireAdminAuth } from "../auth/admin-middleware";
import { runAnalyticsQuery } from "../lib/analytics-query";
import { adminFilterClause, cutoverClause } from "../lib/admin-filter";
import { requireAdminAccount } from "../auth/admin";

function clampDays(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(90, Math.floor(n)));
}

function includeAdmins(query: string | undefined): boolean {
  return query === "1";
}

export const adminAnalyticsRoutes = new Hono<HonoEnv>();

// GET /admin/analytics/dau?days=30 — devices active per day for the last N days.
adminAnalyticsRoutes.get("/admin/analytics/dau", requireAdminAuth, async (c) => {
  await requireAdminAccount(c);
  const days = clampDays(c.req.query("days"), 30);
  const cutover = cutoverClause(c.env);
  const filter = adminFilterClause(c.env, includeAdmins(c.req.query("include_admins")));
  const rows = await runAnalyticsQuery<{ day: string; devices: number }>(
    c.env,
    `SELECT toDate(timestamp) AS day, count(DISTINCT blob2) AS devices
     FROM youcoded_app_events
     WHERE blob1 = 'heartbeat' ${cutover} AND timestamp > NOW() - INTERVAL '${days}' DAY ${filter}
     GROUP BY day ORDER BY day`
  );
  return c.json(rows);
});

// GET /admin/analytics/mau — rolling 30-day distinct devices.
adminAnalyticsRoutes.get("/admin/analytics/mau", requireAdminAuth, async (c) => {
  await requireAdminAccount(c);
  const cutover = cutoverClause(c.env);
  const filter = adminFilterClause(c.env, includeAdmins(c.req.query("include_admins")));
  const rows = await runAnalyticsQuery<{ devices: number }>(
    c.env,
    `SELECT count(DISTINCT blob2) AS devices
     FROM youcoded_app_events
     WHERE blob1 = 'heartbeat' ${cutover} AND timestamp > NOW() - INTERVAL '30' DAY ${filter}`
  );
  return c.json({ mau: rows[0]?.devices ?? 0 });
});

// GET /admin/analytics/installs?days=N — derived from first-seen device per day.
//
// AE SQL subquery support: validated at deploy-time smoke test (Task 7). If
// the subquery 422s, fall back to the two-query JS path documented in the
// plan: fetch (blob2, MIN(timestamp)) rows, group by day in JS.
adminAnalyticsRoutes.get("/admin/analytics/installs", requireAdminAuth, async (c) => {
  await requireAdminAccount(c);
  const days = clampDays(c.req.query("days"), 90);
  const cutover = cutoverClause(c.env);
  const filter = adminFilterClause(c.env, includeAdmins(c.req.query("include_admins")));
  const rows = await runAnalyticsQuery<{ day: string; installs: number }>(
    c.env,
    `SELECT toDate(first_seen) AS day, count() AS installs
     FROM (
       SELECT blob2, MIN(timestamp) AS first_seen
       FROM youcoded_app_events
       WHERE blob1 = 'heartbeat' ${cutover} ${filter}
       GROUP BY blob2
     )
     WHERE first_seen > NOW() - INTERVAL '${days}' DAY
     GROUP BY day ORDER BY day`
  );
  return c.json(rows);
});

// GET /admin/analytics/versions — rolling 24h devices by version.
adminAnalyticsRoutes.get("/admin/analytics/versions", requireAdminAuth, async (c) => {
  await requireAdminAccount(c);
  const cutover = cutoverClause(c.env);
  const filter = adminFilterClause(c.env, includeAdmins(c.req.query("include_admins")));
  const rows = await runAnalyticsQuery<{ version: string; devices: number }>(
    c.env,
    `SELECT blob3 AS version, count(DISTINCT blob2) AS devices
     FROM youcoded_app_events
     WHERE blob1 = 'heartbeat' ${cutover} AND timestamp > NOW() - INTERVAL '1' DAY ${filter}
     GROUP BY version ORDER BY devices DESC`
  );
  return c.json(rows);
});

// GET /admin/analytics/platforms — rolling 30-day split.
adminAnalyticsRoutes.get("/admin/analytics/platforms", requireAdminAuth, async (c) => {
  await requireAdminAccount(c);
  const cutover = cutoverClause(c.env);
  const filter = adminFilterClause(c.env, includeAdmins(c.req.query("include_admins")));
  const rows = await runAnalyticsQuery<{ platform: string; devices: number }>(
    c.env,
    `SELECT blob4 AS platform, count(DISTINCT blob2) AS devices
     FROM youcoded_app_events
     WHERE blob1 = 'heartbeat' ${cutover} AND timestamp > NOW() - INTERVAL '30' DAY ${filter}
     GROUP BY platform ORDER BY devices DESC`
  );
  return c.json(rows);
});

// GET /admin/analytics/countries — rolling 30-day top 20.
adminAnalyticsRoutes.get("/admin/analytics/countries", requireAdminAuth, async (c) => {
  await requireAdminAccount(c);
  const cutover = cutoverClause(c.env);
  const filter = adminFilterClause(c.env, includeAdmins(c.req.query("include_admins")));
  const rows = await runAnalyticsQuery<{ country: string; devices: number }>(
    c.env,
    `SELECT blob6 AS country, count(DISTINCT blob2) AS devices
     FROM youcoded_app_events
     WHERE blob1 = 'heartbeat' ${cutover} AND timestamp > NOW() - INTERVAL '30' DAY ${filter}
     GROUP BY country ORDER BY devices DESC LIMIT 20`
  );
  return c.json(rows);
});

// GET /admin/analytics/regions — rolling 30-day top 20 ISO 3166-2 regions. NEW.
adminAnalyticsRoutes.get("/admin/analytics/regions", requireAdminAuth, async (c) => {
  await requireAdminAccount(c);
  const cutover = cutoverClause(c.env);
  const filter = adminFilterClause(c.env, includeAdmins(c.req.query("include_admins")));
  const rows = await runAnalyticsQuery<{ region: string; devices: number }>(
    c.env,
    `SELECT blob7 AS region, count(DISTINCT blob2) AS devices
     FROM youcoded_app_events
     WHERE blob1 = 'heartbeat' ${cutover} AND timestamp > NOW() - INTERVAL '30' DAY ${filter}
     GROUP BY region ORDER BY devices DESC LIMIT 20`
  );
  return c.json(rows);
});
