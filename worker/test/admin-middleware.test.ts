import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { requireAdminAuth } from "../src/auth/admin-middleware";
import type { HonoEnv } from "../src/types";
import { __resetPatCacheForTests } from "../src/auth/pat";

const origFetch = globalThis.fetch;

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

function buildApp() {
  const app = new Hono<HonoEnv>();
  app.onError((err, c) => {
    const status = (err as any).status ?? 500;
    return c.json({ error: err.message }, status);
  });
  app.get("/probe", requireAdminAuth, (c) => c.json({ userId: c.get("userId") }));
  return app;
}

describe("requireAdminAuth", () => {
  beforeEach(async () => {
    for (const t of ["sessions","users"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
    __resetPatCacheForTests();
  });
  afterEach(() => { globalThis.fetch = origFetch; });

  it("accepts a valid session Bearer token", async () => {
    const app = buildApp();
    const token = await seed("github:42");
    const res = await app.request("/probe", { headers: { Authorization: `Bearer ${token}` } }, env);
    expect(res.status).toBe(200);
    const body = await res.json<{ userId: string }>();
    expect(body.userId).toBe("github:42");
  });

  it("accepts a valid X-GitHub-PAT header", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: 7 }), { status: 200 })
    ) as any;
    const app = buildApp();
    const res = await app.request("/probe", { headers: { "X-GitHub-PAT": "ghp_fake" } }, env);
    expect(res.status).toBe(200);
    const body = await res.json<{ userId: string }>();
    expect(body.userId).toBe("github:7");
  });

  it("rejects a request with neither header", async () => {
    const app = buildApp();
    const res = await app.request("/probe", {}, env);
    expect(res.status).toBe(401);
  });

  it("rejects an invalid PAT", async () => {
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 401 })) as any;
    const app = buildApp();
    const res = await app.request("/probe", { headers: { "X-GitHub-PAT": "ghp_bad" } }, env);
    expect(res.status).toBe(401);
  });

  it("rejects an invalid session Bearer token", async () => {
    const app = buildApp();
    const res = await app.request("/probe", { headers: { Authorization: "Bearer not-a-real-token" } }, env);
    expect(res.status).toBe(401);
  });
});
