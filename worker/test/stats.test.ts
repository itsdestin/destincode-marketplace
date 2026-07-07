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
    for (const t of ["sessions","users","installs","ratings","theme_likes","reports","device_codes"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
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

  it("sets Cache-Control: public, max-age=300", async () => {
    const res = await SELF.fetch("https://test.local/stats");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
  });
});
