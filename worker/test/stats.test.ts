import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";

async function seedRatings(pluginId: string, starValues: number[]): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < starValues.length; i++) {
    const userId = `github:${pluginId}:${i}`;
    await env.DB.prepare("INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)")
      .bind(userId, `u${i}`, now).run();
    await env.DB.prepare("INSERT INTO installs (user_id, plugin_id, installed_at) VALUES (?, ?, ?)")
      .bind(userId, pluginId, now).run();
    await env.DB.prepare(
      `INSERT INTO ratings (user_id, plugin_id, stars, created_at, updated_at, hidden)
       VALUES (?, ?, ?, ?, ?, 0)`
    ).bind(userId, pluginId, starValues[i], now, now).run();
  }
}

describe("GET /stats", () => {
  beforeEach(async () => {
    for (const t of ["sessions","users","installs","ratings","thumbs","comments","theme_likes","reports","device_codes"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });

  it("counts thumbs up and down per plugin, and defaults both to 0", async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const [uid, vote] of [["u-a", 1], ["u-b", -1], ["u-c", 1]] as const) {
      await env.DB.prepare("INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)")
        .bind(uid, uid, now).run();
      await env.DB.prepare("INSERT INTO thumbs (user_id, plugin_id, vote, created_at, updated_at) VALUES (?, 'voted', ?, ?, ?)")
        .bind(uid, vote, now, now).run();
    }
    await env.DB.prepare("INSERT INTO installs (user_id, plugin_id, installed_at) VALUES ('u-a', 'installed-only', ?)")
      .bind(now).run();

    const body = await (await SELF.fetch("https://test.local/stats"))
      .json<{ plugins: Record<string, { installs: number; thumbs_up: number; thumbs_down: number }> }>();
    expect(body.plugins["voted"]).toMatchObject({ thumbs_up: 2, thumbs_down: 1 });
    // A plugin with installs but no votes must report 0/0, not undefined — the
    // card reads these directly.
    expect(body.plugins["installed-only"]).toMatchObject({ installs: 1, thumbs_up: 0, thumbs_down: 0 });
  });

  it("returns per-plugin install counts", async () => {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)")
      .bind("github:1", "u1", now).run();
    await env.DB.prepare("INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)")
      .bind("github:2", "u2", now).run();
    await env.DB.prepare("INSERT INTO installs (user_id, plugin_id, installed_at) VALUES (?, ?, ?)")
      .bind("github:1", "foo", now).run();
    await env.DB.prepare("INSERT INTO installs (user_id, plugin_id, installed_at) VALUES (?, ?, ?)")
      .bind("github:2", "foo", now).run();

    const res = await SELF.fetch("https://test.local/stats");
    expect(res.status).toBe(200);
    const body = await res.json() as { plugins: Record<string, { installs: number }> };
    expect(body.plugins["foo"]?.installs).toBe(2);
  });

  it("returns Bayesian-averaged rating and review count", async () => {
    await seedRatings("foo", [5]);
    const res = await SELF.fetch("https://test.local/stats");
    const body = await res.json() as { plugins: Record<string, { rating: number; review_count: number }> };
    expect(body.plugins["foo"]?.review_count).toBe(1);
    expect(body.plugins["foo"]?.rating).toBeCloseTo(3.75, 2);
  });

  it("ignores hidden ratings in the average", async () => {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)")
      .bind("github:a", "a", now).run();
    await env.DB.prepare("INSERT INTO installs (user_id, plugin_id, installed_at) VALUES (?, ?, ?)")
      .bind("github:a", "foo", now).run();
    await env.DB.prepare(
      `INSERT INTO ratings (user_id, plugin_id, stars, created_at, updated_at, hidden)
       VALUES ('github:a', 'foo', 1, ?, ?, 1)`
    ).bind(now, now).run();
    const res = await SELF.fetch("https://test.local/stats");
    const body = await res.json() as { plugins: Record<string, { rating: number; review_count: number }> };
    expect(body.plugins["foo"]?.review_count ?? 0).toBe(0);
  });

  it("includes per-theme like counts", async () => {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)")
      .bind("github:1", "u1", now).run();
    await env.DB.prepare("INSERT INTO theme_likes (user_id, theme_id, liked_at) VALUES (?, ?, ?)")
      .bind("github:1", "strawberry-kitty", now).run();
    const res = await SELF.fetch("https://test.local/stats");
    const body = await res.json() as { themes: Record<string, { likes: number }> };
    expect(body.themes["strawberry-kitty"]?.likes).toBe(1);
  });

  // ── Theme installs (Task 22) ────────────────────────────────────────────────
  // The app records a theme install under a `theme:<slug>` plugin id. /stats
  // has to strip that prefix into themes[], and must NOT also leave the row in
  // plugins[] — otherwise one install is reported twice under two ids.

  it("counts theme installs into themes[slug].installs with the prefix stripped", async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const uid of ["github:1", "github:2"]) {
      await env.DB.prepare("INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)")
        .bind(uid, uid, now).run();
      await env.DB.prepare("INSERT INTO installs (user_id, plugin_id, installed_at) VALUES (?, ?, ?)")
        .bind(uid, "theme:strawberry-kitty", now).run();
    }
    const body = await (await SELF.fetch("https://test.local/stats"))
      .json<{ plugins: Record<string, unknown>; themes: Record<string, { installs: number; likes: number }> }>();
    expect(body.themes["strawberry-kitty"]?.installs).toBe(2);
    // Not counted a second time as a plugin, under either spelling.
    expect(body.plugins["theme:strawberry-kitty"]).toBeUndefined();
    expect(body.plugins["strawberry-kitty"]).toBeUndefined();
  });

  it("gives every theme entry both fields, whichever half seeded it", async () => {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)")
      .bind("github:1", "u1", now).run();
    await env.DB.prepare("INSERT INTO installs (user_id, plugin_id, installed_at) VALUES (?, ?, ?)")
      .bind("github:1", "theme:installed-only", now).run();
    await env.DB.prepare("INSERT INTO theme_likes (user_id, theme_id, liked_at) VALUES (?, ?, ?)")
      .bind("github:1", "liked-only", now).run();
    const body = await (await SELF.fetch("https://test.local/stats"))
      .json<{ themes: Record<string, { installs: number; likes: number }> }>();
    expect(body.themes["installed-only"]).toMatchObject({ installs: 1, likes: 0 });
    expect(body.themes["liked-only"]).toMatchObject({ installs: 0, likes: 1 });
  });

  it("leaves a plugin whose id merely contains 'theme' alone", async () => {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)")
      .bind("github:1", "u1", now).run();
    await env.DB.prepare("INSERT INTO installs (user_id, plugin_id, installed_at) VALUES (?, ?, ?)")
      .bind("github:1", "theme-builder", now).run();
    const body = await (await SELF.fetch("https://test.local/stats"))
      .json<{ plugins: Record<string, { installs: number }>; themes: Record<string, unknown> }>();
    expect(body.plugins["theme-builder"]?.installs).toBe(1);
    expect(body.themes["builder"]).toBeUndefined();
  });

  it("sets Cache-Control: public, max-age=300", async () => {
    const res = await SELF.fetch("https://test.local/stats");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
  });
});
