import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createTestAccount, issueTestSession } from "./helpers";

function authed(path: string, token: string, init: RequestInit = {}) {
  return SELF.fetch(`https://test.local${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
}

describe("GET /social/users/:handle", () => {
  it("requires a session", async () => {
    const res = await SELF.fetch("https://test.local/social/users/somebody");
    expect(res.status).toBe(401);
  });

  it("returns a minimal card for an exact handle match", async () => {
    const me = await createTestAccount();
    const them = await createTestAccount({ handle: "findme" });
    const token = await issueTestSession(me);
    const res = await authed("/social/users/findme", token);
    expect(res.status).toBe(200);
    const card = await res.json() as any;
    expect(card).toEqual({
      id: them.userId, display_name: them.login, handle: "findme", avatar_url: null,
    });
  });

  it("matches case-insensitively (handles are stored lowercase)", async () => {
    await createTestAccount({ handle: "mixedcase" });
    const me = await createTestAccount();
    const token = await issueTestSession(me);
    const res = await authed("/social/users/MixedCase", token);
    expect(res.status).toBe(200);
  });

  it("404s for unknown handles", async () => {
    const me = await createTestAccount();
    const token = await issueTestSession(me);
    const res = await authed("/social/users/nobody-here", token);
    expect(res.status).toBe(404);
  });

  it("404s (indistinguishably) when a block exists in either direction", async () => {
    const me = await createTestAccount();
    const them = await createTestAccount({ handle: "blocked-me" });
    const token = await issueTestSession(me);
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("INSERT INTO blocks (blocker, blocked, created_at) VALUES (?, ?, ?)")
      .bind(them.userId, me.userId, now).run();
    const res = await authed("/social/users/blocked-me", token);
    expect(res.status).toBe(404);
    const missing = await authed("/social/users/nobody-here", token);
    expect(await res.text()).toBe(await missing.text()); // same body — no block-probing oracle
  });
});
