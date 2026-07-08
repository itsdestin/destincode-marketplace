import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createTestAccount, issueTestSession } from "./helpers";

function authed(path: string, token: string, init: RequestInit = {}) {
  return SELF.fetch(`https://test.local${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
}

describe("blocks", () => {
  it("blocking severs the friendship and pending requests both ways", async () => {
    const a = await createTestAccount();
    const b = await createTestAccount();
    const now = Math.floor(Date.now() / 1000);
    const [low, high] = a.userId < b.userId ? [a.userId, b.userId] : [b.userId, a.userId];
    // Pending requests in BOTH directions so each arm of the severing DELETE's
    // OR clause is exercised against a real row.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO friendships (user_low, user_high, created_at) VALUES (?, ?, ?)").bind(low, high, now),
      env.DB.prepare("INSERT INTO friend_requests (id, from_user, to_user, created_at) VALUES ('freq_x1', ?, ?, ?)").bind(b.userId, a.userId, now),
      env.DB.prepare("INSERT INTO friend_requests (id, from_user, to_user, created_at) VALUES ('freq_x2', ?, ?, ?)").bind(a.userId, b.userId, now),
    ]);
    const token = await issueTestSession(a);
    const res = await authed("/social/blocks", token, { method: "POST", body: JSON.stringify({ user_id: b.userId }) });
    expect(res.status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM friendships").first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM friend_requests").first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM blocks WHERE blocker = ?").bind(a.userId).first<{ n: number }>())!.n).toBe(1);
  });

  it("list shows only my own blocks, as cards; unblock removes", async () => {
    const a = await createTestAccount();
    const b = await createTestAccount({ handle: `bad${Date.now() % 100000}` });
    const token = await issueTestSession(a);
    await authed("/social/blocks", token, { method: "POST", body: JSON.stringify({ user_id: b.userId }) });
    const list = (await (await authed("/social/blocks", token)).json()) as any[];
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(b.userId);
    const un = await authed(`/social/blocks/${b.userId}`, token, { method: "DELETE" });
    expect(un.status).toBe(200);
    expect((await (await authed("/social/blocks", token)).json()) as any[]).toHaveLength(0);
  });

  it("blocking yourself or a nonexistent user 400s/404s; double-block is idempotent", async () => {
    const a = await createTestAccount();
    const b = await createTestAccount();
    const token = await issueTestSession(a);
    expect((await authed("/social/blocks", token, { method: "POST", body: JSON.stringify({ user_id: a.userId }) })).status).toBe(400);
    expect((await authed("/social/blocks", token, { method: "POST", body: JSON.stringify({ user_id: "acct_nope" }) })).status).toBe(404);
    await authed("/social/blocks", token, { method: "POST", body: JSON.stringify({ user_id: b.userId }) });
    expect((await authed("/social/blocks", token, { method: "POST", body: JSON.stringify({ user_id: b.userId }) })).status).toBe(200);
  });

  it("a block is owner-only — the blocked party's list never shows it", async () => {
    // a blocks b; from b's perspective GET /social/blocks must be empty. Pins
    // that block visibility is scoped to the blocker, never the blocked victim.
    const a = await createTestAccount();
    const b = await createTestAccount();
    const aToken = await issueTestSession(a);
    const bToken = await issueTestSession(b);
    await authed("/social/blocks", aToken, { method: "POST", body: JSON.stringify({ user_id: b.userId }) });
    expect((await (await authed("/social/blocks", bToken)).json()) as any[]).toHaveLength(0);
  });

  it("unblock does NOT restore a severed friendship — ex-block is stranger-state", async () => {
    const a = await createTestAccount();
    const b = await createTestAccount();
    const [low, high] = a.userId < b.userId ? [a.userId, b.userId] : [b.userId, a.userId];
    await env.DB.prepare("INSERT INTO friendships (user_low, user_high, created_at) VALUES (?, ?, ?)")
      .bind(low, high, Math.floor(Date.now() / 1000)).run();
    const token = await issueTestSession(a);
    await authed("/social/blocks", token, { method: "POST", body: JSON.stringify({ user_id: b.userId }) });
    const un = await authed(`/social/blocks/${b.userId}`, token, { method: "DELETE" });
    expect(un.status).toBe(200);
    // The block severed the friendship; unblocking must leave the pair as strangers.
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM friendships").first<{ n: number }>())!.n).toBe(0);
  });

  it("unblocking someone you never blocked 404s", async () => {
    const a = await createTestAccount();
    const b = await createTestAccount();
    const token = await issueTestSession(a);
    expect((await authed(`/social/blocks/${b.userId}`, token, { method: "DELETE" })).status).toBe(404);
  });
});
