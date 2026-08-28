// Marketplace feedback — thumbs + comments (spec §1.7). Shapes follow
// ratings/routes.ts: authed writes gate on a prior install (thumbs) and run
// the llama-guard classifier (comments); the public read mirrors
// GET /ratings/:plugin_id (IP rate limit, LIMIT 50, hidden rows excluded).
//
// ONE router for every route in this feature. A second router is easy to write
// and easy to forget to app.route() — the failure is silent: tests green, routes
// 404 in production.
import { Hono } from "hono";
import type { Context } from "hono";
import type { HonoEnv } from "../types";
import { requireAuth } from "../auth/middleware";
import { badRequest, forbidden, tooMany } from "../lib/errors";
import { validateId } from "../lib/validate";
import { parseJsonBody } from "../lib/parse-json";
import { checkRateLimit } from "../lib/rate-limit";
import { hasInstall } from "../db";
import { classifyReview } from "../ratings/moderation";
import { randomToken } from "../lib/crypto";
import { parseVote, validateCommentText } from "./validate";

export const feedbackRoutes = new Hono<HonoEnv>();

// POST /thumbs { plugin_id, value: "up" | "down" | null }
//   → { ok, vote, thumbs_up, thumbs_down }
// One vote per (user, plugin); null clears it. Install-gated like ratings.
// Honest about what that buys: it stops a drive-by, not a determined actor —
// POST /installs takes any string as a plugin_id with no existence or provenance
// check, so anyone can record a fake install and then vote. Plan 2's
// catalog_items existence check is what turns this into a real gate.
feedbackRoutes.post("/thumbs", requireAuth, async (c) => {
  const userId = c.get("userId");
  if (!(await checkRateLimit(`thumbs:${userId}`, 60, 3600))) {
    throw tooMany("too many votes per hour");
  }
  const body = await parseJsonBody<{ plugin_id?: string; value?: unknown }>(c);
  const pluginId = validateId(body.plugin_id);
  let vote: 1 | -1 | null;
  try { vote = parseVote(body.value); }
  catch (e) { throw badRequest((e as Error).message); }

  if (!(await hasInstall(c.env.DB, userId, pluginId))) {
    throw forbidden("must install plugin before voting");
  }

  const now = Math.floor(Date.now() / 1000);
  if (vote === null) {
    await c.env.DB.prepare("DELETE FROM thumbs WHERE user_id = ? AND plugin_id = ?")
      .bind(userId, pluginId).run();
  } else {
    await c.env.DB
      .prepare(
        `INSERT INTO thumbs (user_id, plugin_id, vote, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, plugin_id) DO UPDATE SET vote = excluded.vote, updated_at = excluded.updated_at`
      )
      .bind(userId, pluginId, vote, now, now)
      .run();
  }

  // Hand the fresh totals back with the write. One indexed read (idx_thumbs_plugin),
  // and it is the difference between the number moving when you click and the app
  // re-fetching /stats to find out — which it cannot usefully do, because /stats is
  // served Cache-Control: max-age=300 while the renderer's refresh() only bypasses
  // its OWN in-memory cache. Without this the count would sit unchanged for up to
  // five minutes after a successful vote, which reads as "it didn't save".
  const totals = await c.env.DB
    .prepare(
      `SELECT SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END) AS up,
              SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END) AS down
       FROM thumbs WHERE plugin_id = ?`
    )
    .bind(pluginId)
    .first<{ up: number | null; down: number | null }>();
  return c.json({
    ok: true,
    vote: vote === null ? null : vote === 1 ? "up" : "down",
    // SUM over zero rows is NULL, not 0.
    thumbs_up: totals?.up ?? 0,
    thumbs_down: totals?.down ?? 0,
  });
});

// POST /comments { plugin_id, text } → { ok, id, hidden }
// Sign-in only — no install gate: asking "does this work offline?" BEFORE
// installing is the point. Same classifier as reviews; flagged text is stored
// hidden so the admin queue (GET /admin/comments) can look at it.
feedbackRoutes.post("/comments", requireAuth, async (c) => {
  const userId = c.get("userId");
  if (!(await checkRateLimit(`comments:${userId}`, 20, 3600))) {
    throw tooMany("too many comments per hour");
  }
  const body = await parseJsonBody<{ plugin_id?: string; text?: unknown }>(c);
  const pluginId = validateId(body.plugin_id);
  let text: string;
  try { text = validateCommentText(body.text); }
  catch (e) { throw badRequest((e as Error).message); }

  const verdict = await classifyReview(c.env.AI, text);
  const hidden = verdict.safe ? 0 : 1;
  const id = randomToken(16);
  await c.env.DB
    .prepare("INSERT INTO comments (id, user_id, plugin_id, text, created_at, hidden) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, userId, pluginId, text, Math.floor(Date.now() / 1000), hidden)
    .run();
  return c.json({ ok: true, id, hidden: hidden === 1 });
});

// GET /comments/<id> → { comments } — public, newest first, LIMIT 50, hidden
// excluded. Wire names match GET /ratings (user_login / user_avatar_url) because
// the app's CommentList already reads them.
//
// TWO routes, one handler: a bundle member's id is `<bundle>/<name>` (spec §1.4),
// and Hono's `:param` never matches across a slash — a single-segment route would
// 404 every member page's comment thread. The two patterns have different segment
// counts, so they can never both match one URL and registration order is
// irrelevant.
async function listComments(c: Context<HonoEnv>, pluginId: string) {
  const ip = c.req.raw.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await checkRateLimit(`comments-list:${ip}`, 60, 60))) {
    throw tooMany("too many requests");
  }
  const { results } = await c.env.DB
    .prepare(
      `SELECT m.id, m.user_id, u.display_name, u.avatar_url, m.text, m.created_at
       FROM comments m
       JOIN users u ON u.id = m.user_id
       WHERE m.plugin_id = ? AND m.hidden = 0
       ORDER BY m.created_at DESC
       LIMIT 50`
    )
    .bind(pluginId)
    .all<{ id: string; user_id: string; display_name: string; avatar_url: string | null; text: string; created_at: number }>();
  const comments = results.map((row) => ({
    id: row.id,
    user_id: row.user_id,
    user_login: row.display_name,
    user_avatar_url: row.avatar_url,
    text: row.text,
    created_at: row.created_at,
  }));
  return c.json({ comments });
}

feedbackRoutes.get("/comments/:bundle/:name", (c) =>
  listComments(c, validateId(`${c.req.param("bundle")}/${c.req.param("name")}`))
);
feedbackRoutes.get("/comments/:plugin_id", (c) => listComments(c, validateId(c.req.param("plugin_id"))));
