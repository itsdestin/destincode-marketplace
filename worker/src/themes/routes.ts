import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { requireAuth } from "../auth/middleware";
import { validateId } from "../lib/validate";

export const themeRoutes = new Hono<HonoEnv>();

themeRoutes.post("/themes/:id/like", requireAuth, async (c) => {
  const themeId = validateId(c.req.param("id"), "theme id");
  const userId = c.get("userId");
  const existing = await c.env.DB
    .prepare("SELECT 1 AS one FROM theme_likes WHERE user_id = ? AND theme_id = ?")
    .bind(userId, themeId)
    .first<{ one: number }>();
  if (existing) {
    await c.env.DB
      .prepare("DELETE FROM theme_likes WHERE user_id = ? AND theme_id = ?")
      .bind(userId, themeId)
      .run();
    return c.json({ liked: false });
  }
  await c.env.DB
    .prepare("INSERT INTO theme_likes (user_id, theme_id, liked_at) VALUES (?, ?, ?)")
    .bind(userId, themeId, Math.floor(Date.now() / 1000))
    .run();
  return c.json({ liked: true });
});
