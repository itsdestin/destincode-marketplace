import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { bayesianAverage } from "./bayesian";

export const statsRoutes = new Hono<HonoEnv>();

interface PluginAgg { installs: number; review_count: number; rating: number; thumbs_up: number; thumbs_down: number }
interface ThemeAgg { likes: number }

statsRoutes.get("/stats", async (c) => {
  const installRows = await c.env.DB
    .prepare("SELECT plugin_id, COUNT(*) AS n FROM installs GROUP BY plugin_id")
    .all<{ plugin_id: string; n: number }>();
  const ratingRows = await c.env.DB
    .prepare(
      `SELECT plugin_id, AVG(stars) AS avg_stars, COUNT(*) AS n
       FROM ratings WHERE hidden = 0 GROUP BY plugin_id`
    )
    .all<{ plugin_id: string; avg_stars: number; n: number }>();
  const likeRows = await c.env.DB
    .prepare("SELECT theme_id, COUNT(*) AS n FROM theme_likes GROUP BY theme_id")
    .all<{ theme_id: string; n: number }>();
  // Marketplace overhaul: one-tap votes. SUM over CASE keeps it one GROUP BY.
  const thumbRows = await c.env.DB
    .prepare(
      `SELECT plugin_id,
              SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END) AS up,
              SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END) AS down
       FROM thumbs GROUP BY plugin_id`
    )
    .all<{ plugin_id: string; up: number; down: number }>();

  // Every entry carries every field: MarketplaceCard reads thumbs_up/thumbs_down
  // straight off the object, so a partially-seeded entry would render undefined.
  const EMPTY: PluginAgg = { installs: 0, review_count: 0, rating: 0, thumbs_up: 0, thumbs_down: 0 };
  const plugins: Record<string, PluginAgg> = {};
  for (const r of installRows.results) {
    plugins[r.plugin_id] = { ...EMPTY, installs: r.n };
  }
  for (const r of ratingRows.results) {
    const entry = plugins[r.plugin_id] ?? { ...EMPTY };
    entry.review_count = r.n;
    entry.rating = Math.round(bayesianAverage(r.avg_stars, r.n) * 100) / 100;
    plugins[r.plugin_id] = entry;
  }
  for (const r of thumbRows.results) {
    const entry = plugins[r.plugin_id] ?? { ...EMPTY };
    entry.thumbs_up = r.up;
    entry.thumbs_down = r.down;
    plugins[r.plugin_id] = entry;
  }

  const themes: Record<string, ThemeAgg> = {};
  for (const r of likeRows.results) themes[r.theme_id] = { likes: r.n };

  c.header("Cache-Control", "public, max-age=300");
  return c.json({
    generated_at: Math.floor(Date.now() / 1000),
    plugins,
    themes,
  });
});
