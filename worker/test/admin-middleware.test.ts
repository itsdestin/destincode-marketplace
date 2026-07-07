import { env } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { requireAdminAuth } from "../src/auth/admin-middleware";
import type { HonoEnv } from "../src/types";
import { __resetPatCacheForTests } from "../src/auth/pat";
import { isAdminAccount } from "../src/auth/admin";
import { createTestAccount, issueTestSession } from "./helpers";

const origFetch = globalThis.fetch;

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
    for (const t of ["sessions","identities","users"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
    __resetPatCacheForTests();
  });
  afterEach(() => { globalThis.fetch = origFetch; });

  it("accepts a valid session Bearer token", async () => {
    const app = buildApp();
    const acct = await createTestAccount({ githubId: "42" });
    const token = await issueTestSession(acct);
    const res = await app.request("/probe", { headers: { Authorization: `Bearer ${token}` } }, env);
    expect(res.status).toBe(200);
    const body = await res.json<{ userId: string }>();
    expect(body.userId).toBe(acct.userId);
  });

  it("accepts a valid X-GitHub-PAT header", async () => {
    // PAT resolves via GitHub /user (mocked id) → identities → account id.
    const acct = await createTestAccount({ githubId: "7" });
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: 7 }), { status: 200 })
    ) as any;
    const app = buildApp();
    const res = await app.request("/probe", { headers: { "X-GitHub-PAT": "ghp_fake" } }, env);
    expect(res.status).toBe(200);
    const body = await res.json<{ userId: string }>();
    expect(body.userId).toBe(acct.userId);
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

describe("isAdminAccount", () => {
  beforeEach(async () => {
    for (const t of ["identities", "users"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });

  it("admits an account whose github identity is allowlisted", async () => {
    const acct = await createTestAccount({ githubId: "777001" });
    expect(await isAdminAccount(env.DB, { ADMIN_USER_IDS: "777001, 888002" }, acct.userId)).toBe(true);
  });

  it("rejects non-allowlisted, empty allowlist, and unknown accounts", async () => {
    const acct = await createTestAccount({ githubId: "777003" });
    expect(await isAdminAccount(env.DB, { ADMIN_USER_IDS: "999999" }, acct.userId)).toBe(false);
    expect(await isAdminAccount(env.DB, { ADMIN_USER_IDS: "" }, acct.userId)).toBe(false);
    expect(await isAdminAccount(env.DB, { ADMIN_USER_IDS: "777003" }, "acct_nonexistent")).toBe(false);
  });
});
