import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { requireAuth } from "../auth/middleware";
import { badRequest, forbidden, tooMany } from "../lib/errors";
import { validateId, requireCatalogId } from "../lib/validate";
import { hasInstall } from "../db";
import { classifyReview, validateReviewText } from "./moderation";
import { checkRateLimit } from "../lib/rate-limit";
import { parseJsonBody } from "../lib/parse-json";

// Shape returned by GET /ratings/:plugin_id for a single review entry.
interface RatingListEntry {
  id: string;            // "<user_id>:<plugin_id>" — stable opaque key for React list rendering
  user_id: string;
  user_login: string;
  user_avatar_url: string | null;
  stars: number;
  review_text: string | null;
  created_at: number;   // unix seconds, matches the ratings table column
}

export const ratingRoutes = new Hono<HonoEnv>();

// Submit or update a rating. Gated on the caller having previously installed
// the plugin (seen in the installs table) so ratings correspond to real use.
// Review text is validated, and flagged reviews are stored with hidden=1.
ratingRoutes.post("/ratings", requireAuth, async (c) => {
  // Rate limit: cap casual abuse (bots/mass-review scripts) before we do any
  // expensive work like moderation classification.
  const userId = c.get("userId");
  if (!(await checkRateLimit(`ratings:${userId}`, 30, 3600))) {
    throw tooMany("too many ratings per hour");
  }
  // parseJsonBody, not c.req.json(): a malformed body throws a plain SyntaxError that
  // onError reports as a 500 ("we broke") when the truth is a 400 ("your request was
  // broken"). Every other route already parses through this helper.
  const body = await parseJsonBody<{ plugin_id?: string; stars?: number; review_text?: string | null }>(c);
  const pluginId = await requireCatalogId(c.env.DB, body.plugin_id);
  const stars = body.stars;
  if (typeof stars !== "number" || !Number.isInteger(stars) || stars < 1 || stars > 5) {
    throw badRequest("stars must be an integer 1-5");
  }

  let text: string | null;
  try {
    text = validateReviewText(body.review_text);
  } catch (e) {
    throw badRequest((e as Error).message);
  }

  const installed = await hasInstall(c.env.DB, userId, pluginId);
  if (!installed) throw forbidden("must install plugin before rating");

  let hidden = 0;
  if (text) {
    const verdict = await classifyReview(c.env.AI, text);
    if (!verdict.safe) hidden = 1;
  }

  const now = Math.floor(Date.now() / 1000);
  await c.env.DB
    .prepare(
      `INSERT INTO ratings (user_id, plugin_id, stars, review_text, created_at, updated_at, hidden)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, plugin_id) DO UPDATE SET
         stars = excluded.stars,
         review_text = excluded.review_text,
         updated_at = excluded.updated_at,
         hidden = excluded.hidden`
    )
    .bind(userId, pluginId, stars, text, now, now, hidden)
    .run();

  return c.json({ ok: true, hidden: hidden === 1 });
});

// Public listing of visible reviews for a plugin. No auth required — same as
// GET /stats. Results are capped at 50 rows (newest first) to keep payloads
// bounded; no pagination in v1. Hidden ratings (moderated out) are excluded.
// Rate-limited by IP via Cache API (60 req/min) to deter scraping.
ratingRoutes.get("/ratings/:plugin_id", async (c) => {
  const pluginId = validateId(c.req.param("plugin_id"));

  // Modest IP-based rate limit for a public read endpoint. The Cache API is
  // per-colo so this prevents per-edge abuse, not perfect global throttling —
  // acceptable for v1 (see PITFALLS: "Rate limits via the Cache API are per-colo").
  const ip = c.req.raw.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await checkRateLimit(`ratings-list:${ip}`, 60, 60))) {
    throw tooMany("too many requests");
  }

  // JOIN users so the React UI gets login + avatar in one round-trip.
  // LIMIT 50: hardcoded cap, no pagination for v1.
  // Wire field names (user_login/user_avatar_url) are unchanged — clients already
  // consume them — but they now map from the account-native display_name/avatar_url
  // columns rather than the removed github_* columns (accounts rebuild, spec §1).
  const { results } = await c.env.DB
    .prepare(
      `SELECT r.user_id, u.display_name, u.avatar_url,
              r.stars, r.review_text, r.created_at
       FROM ratings r
       JOIN users u ON u.id = r.user_id
       WHERE r.plugin_id = ? AND r.hidden = 0
       ORDER BY r.created_at DESC
       LIMIT 50`
    )
    .bind(pluginId)
    .all<{
      user_id: string;
      display_name: string;
      avatar_url: string | null;
      stars: number;
      review_text: string | null;
      created_at: number;
    }>();

  const ratings: RatingListEntry[] = results.map((row) => ({
    // Stable composite key for React list rendering — no separate id column exists.
    id: `${row.user_id}:${pluginId}`,
    user_id: row.user_id,
    user_login: row.display_name,
    user_avatar_url: row.avatar_url,
    stars: row.stars,
    review_text: row.review_text,
    created_at: row.created_at,
  }));

  return c.json({ ratings });
});

// Delete the caller's own rating for a plugin. Scoped by user_id so one user
// cannot remove another's review.
ratingRoutes.delete("/ratings/:plugin_id", requireAuth, async (c) => {
  const pluginId = c.req.param("plugin_id");
  const userId = c.get("userId");
  await c.env.DB
    .prepare("DELETE FROM ratings WHERE user_id = ? AND plugin_id = ?")
    .bind(userId, pluginId)
    .run();
  return c.json({ ok: true });
});
