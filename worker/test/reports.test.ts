import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";

async function seed(userId: string, login = "u"): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)")
    .bind(userId, login, now).run();
  const token = `tok-${userId}`;
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(token))))
    .map(b => b.toString(16).padStart(2, "0")).join("");
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, last_used_at) VALUES (?, ?, ?, ?)")
    .bind(hash, userId, now, now).run();
  return token;
}

describe("POST /reports", () => {
  beforeEach(async () => {
    for (const t of ["sessions","users","installs","ratings","reports"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });

  it("records a report", async () => {
    const token = await seed("github:1");
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)")
      .bind("github:99", "badactor", now).run();
    await env.DB.prepare("INSERT INTO installs (user_id, plugin_id, installed_at) VALUES (?, ?, ?)")
      .bind("github:99", "foo", now).run();
    await env.DB.prepare(
      `INSERT INTO ratings (user_id, plugin_id, stars, review_text, created_at, updated_at, hidden)
       VALUES (?, ?, 1, 'terrible thing', ?, ?, 0)`
    ).bind("github:99", "foo", now, now).run();

    const res = await SELF.fetch("https://test.local/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ rating_user_id: "github:99", rating_plugin_id: "foo", reason: "harassment" }),
    });
    expect(res.status).toBe(200);

    const { results } = await env.DB.prepare("SELECT * FROM reports").all<{ rating_user_id: string; reporter_user_id: string }>();
    expect(results).toHaveLength(1);
    expect(results[0]?.reporter_user_id).toBe("github:1");
  });
});

describe("DELETE /admin/ratings/:user_id/:plugin_id", () => {
  beforeEach(async () => {
    for (const t of ["sessions","users","installs","ratings","reports"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });

  it("403s for non-admins", async () => {
    const token = await seed("github:1");
    const res = await SELF.fetch("https://test.local/admin/ratings/github%3A99/foo", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it("hides the rating and marks reports resolved for admins", async () => {
    const token = await seed("github:admin");
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)")
      .bind("github:99", "badactor", now).run();
    await env.DB.prepare("INSERT INTO installs (user_id, plugin_id, installed_at) VALUES (?, ?, ?)")
      .bind("github:99", "foo", now).run();
    await env.DB.prepare(
      `INSERT INTO ratings (user_id, plugin_id, stars, review_text, created_at, updated_at, hidden)
       VALUES ('github:99', 'foo', 1, 'bad', ?, ?, 0)`
    ).bind(now, now).run();
    await env.DB.prepare(
      `INSERT INTO reports (id, rating_user_id, rating_plugin_id, reporter_user_id, created_at)
       VALUES ('r1', 'github:99', 'foo', 'github:admin', ?)`
    ).bind(now).run();

    const res = await SELF.fetch("https://test.local/admin/ratings/github%3A99/foo", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);

    const row = await env.DB.prepare("SELECT hidden FROM ratings WHERE user_id='github:99' AND plugin_id='foo'").first<{ hidden: number }>();
    expect(row?.hidden).toBe(1);
    const reportRow = await env.DB.prepare("SELECT resolution FROM reports WHERE id='r1'").first<{ resolution: string | null }>();
    expect(reportRow?.resolution).toBe("hidden");
  });
});
