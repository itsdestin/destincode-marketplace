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

describe("GET /admin/dashboard", () => {
  beforeEach(async () => {
    for (const t of ["sessions", "users"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });

  it("returns 401 without auth", async () => {
    const res = await SELF.fetch("https://test.local/admin/dashboard");
    expect(res.status).toBe(401);
  });

  it("returns HTML for an authenticated caller (admin gate is route-level, not page-level)", async () => {
    const token = await seed("github:admin");
    const res = await SELF.fetch("https://test.local/admin/dashboard", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toMatch(/YouCoded/);
    expect(body).toMatch(/chart\.umd\.min\.js/);
  });
});
