import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { requireAuth } from "../auth/middleware";
import { tooMany } from "../lib/errors";
import { validateId } from "../lib/validate";
import { checkRateLimit } from "../lib/rate-limit";

export const installRoutes = new Hono<HonoEnv>();

// POST /installs — records that an authenticated user installed a plugin.
// Idempotent via UNIQUE(user_id, plugin_id) + ON CONFLICT DO NOTHING so that
// repeated installs from the same user don't error or double-count.
installRoutes.post("/installs", requireAuth, async (c) => {
  // Rate limit: 100/hour per user is well above normal human behavior but
  // stops scripted install-count inflation.
  const userId = c.get("userId");
  if (!(await checkRateLimit(`installs:${userId}`, 100, 3600))) {
    throw tooMany("too many installs per hour");
  }
  const body = await c.req.json<{ plugin_id?: string }>();
  const pluginId = validateId(body.plugin_id);
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB
    .prepare(
      `INSERT INTO installs (user_id, plugin_id, installed_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id, plugin_id) DO NOTHING`
    )
    .bind(userId, pluginId, now)
    .run();
  return c.json({ ok: true });
});
