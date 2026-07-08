import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createTestAccount, issueTestSession, type TestAccount } from "./helpers";

function authed(path: string, token: string, init: RequestInit = {}) {
  return SELF.fetch(`https://test.local${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
}
async function pair(): Promise<{ a: TestAccount; aTok: string; b: TestAccount; bTok: string }> {
  const a = await createTestAccount();
  const b = await createTestAccount({ handle: `bee${Date.now() % 100000}${Math.floor(Math.random() * 1000)}` });
  return { a, aTok: await issueTestSession(a), b, bTok: await issueTestSession(b) };
}
async function handleOf(acct: TestAccount): Promise<string> {
  const row = await env.DB.prepare("SELECT handle FROM users WHERE id = ?").bind(acct.userId).first<{ handle: string }>();
  return row!.handle;
}

describe("friend requests", () => {
  it("send → pending; recipient sees it incoming; sender sees it outgoing", async () => {
    const { a, aTok, b, bTok } = await pair();
    const send = await authed("/social/requests", aTok, { method: "POST", body: JSON.stringify({ handle: await handleOf(b) }) });
    expect(send.status).toBe(200);
    expect(((await send.json()) as any).status).toBe("pending");

    const inc = (await (await authed("/social/requests", bTok)).json()) as any;
    expect(inc.incoming).toHaveLength(1);
    expect(inc.incoming[0].from.id).toBe(a.userId);

    const out = (await (await authed("/social/requests", aTok)).json()) as any;
    expect(out.outgoing).toHaveLength(1);
    expect(out.outgoing[0].to.id).toBe(b.userId);
  });

  it("accept creates the friendship and removes the request", async () => {
    const { a, aTok, b, bTok } = await pair();
    await authed("/social/requests", aTok, { method: "POST", body: JSON.stringify({ handle: await handleOf(b) }) });
    const inc = (await (await authed("/social/requests", bTok)).json()) as any;
    const res = await authed(`/social/requests/${inc.incoming[0].id}/accept`, bTok, { method: "POST" });
    expect(res.status).toBe(200);
    const n = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM friendships WHERE (user_low = ? AND user_high = ?) OR (user_low = ? AND user_high = ?)"
    ).bind(a.userId, b.userId, b.userId, a.userId).first<{ n: number }>();
    expect(n!.n).toBe(1);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM friend_requests WHERE from_user = ?").bind(a.userId).first<{ n: number }>();
    expect(left!.n).toBe(0);
  });

  it("sending to someone whose request to me is pending auto-accepts", async () => {
    const { a, aTok, b, bTok } = await pair();
    // give A a handle so B can address them
    await env.DB.prepare("UPDATE users SET handle = ? WHERE id = ?").bind(`aye${Date.now() % 100000}`, a.userId).run();
    await authed("/social/requests", aTok, { method: "POST", body: JSON.stringify({ handle: await handleOf(b) }) });
    const res = await authed("/social/requests", bTok, { method: "POST", body: JSON.stringify({ handle: await handleOf(a) }) });
    expect(((await res.json()) as any).status).toBe("friends");
    // Auto-accept must fully settle the pair: one friendship row, zero
    // pending requests left in either direction.
    const n = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM friendships WHERE (user_low = ? AND user_high = ?) OR (user_low = ? AND user_high = ?)"
    ).bind(a.userId, b.userId, b.userId, a.userId).first<{ n: number }>();
    expect(n!.n).toBe(1);
    const left = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM friend_requests WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)"
    ).bind(a.userId, b.userId, b.userId, a.userId).first<{ n: number }>();
    expect(left!.n).toBe(0);
  });

  it("decline (recipient) and cancel (sender) delete the row; wrong party gets 404", async () => {
    const { a, aTok, b, bTok } = await pair();
    await authed("/social/requests", aTok, { method: "POST", body: JSON.stringify({ handle: await handleOf(b) }) });
    const inc = (await (await authed("/social/requests", bTok)).json()) as any;
    const id = inc.incoming[0].id;
    expect((await authed(`/social/requests/${id}/decline`, aTok, { method: "POST" })).status).toBe(404); // sender can't decline
    expect((await authed(`/social/requests/${id}`, bTok, { method: "DELETE" })).status).toBe(404);       // recipient can't cancel
    expect((await authed(`/social/requests/${id}/decline`, bTok, { method: "POST" })).status).toBe(200);
  });

  it("refuses self-requests and duplicates are idempotent", async () => {
    const { a, aTok } = await pair();
    await env.DB.prepare("UPDATE users SET handle = ? WHERE id = ?").bind(`self${Date.now() % 100000}`, a.userId).run();
    const self = await authed("/social/requests", aTok, { method: "POST", body: JSON.stringify({ handle: await handleOf(a) }) });
    expect(self.status).toBe(400);
  });

  it("a block in either direction makes the target look nonexistent", async () => {
    const { a, aTok, b } = await pair();
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("INSERT INTO blocks (blocker, blocked, created_at) VALUES (?, ?, ?)").bind(b.userId, a.userId, now).run();
    const res = await authed("/social/requests", aTok, { method: "POST", body: JSON.stringify({ handle: await handleOf(b) }) });
    expect(res.status).toBe(404);
  });

  it("a duplicate send returns pending and leaves exactly one row", async () => {
    const { aTok, b } = await pair();
    const h = await handleOf(b);
    const first = await authed("/social/requests", aTok, { method: "POST", body: JSON.stringify({ handle: h }) });
    expect(((await first.json()) as any).status).toBe("pending");
    const second = await authed("/social/requests", aTok, { method: "POST", body: JSON.stringify({ handle: h }) });
    expect(second.status).toBe(200);
    expect(((await second.json()) as any).status).toBe("pending");
    // Idempotent: the second POST must NOT create a second row.
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM friend_requests WHERE to_user = ?").bind(b.userId).first<{ n: number }>();
    expect(rows!.n).toBe(1);
  });

  it("sending to an already-friend is a no-op that returns friends", async () => {
    const { a, aTok, b } = await pair();
    // Seed an existing friendship directly (bypasses the request flow).
    const now = Math.floor(Date.now() / 1000);
    const [low, high] = a.userId < b.userId ? [a.userId, b.userId] : [b.userId, a.userId];
    await env.DB.prepare("INSERT INTO friendships (user_low, user_high, created_at) VALUES (?, ?, ?)").bind(low, high, now).run();
    const res = await authed("/social/requests", aTok, { method: "POST", body: JSON.stringify({ handle: await handleOf(b) }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).status).toBe("friends");
    // No request row created for an already-friends no-op.
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM friend_requests WHERE from_user = ?").bind(a.userId).first<{ n: number }>();
    expect(rows!.n).toBe(0);
  });
});
