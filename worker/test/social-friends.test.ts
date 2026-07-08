import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createTestAccount, issueTestSession } from "./helpers";

function authed(path: string, token: string, init: RequestInit = {}) {
  return SELF.fetch(`https://test.local${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  });
}
async function befriend(aId: string, bId: string) {
  const [low, high] = aId < bId ? [aId, bId] : [bId, aId];
  await env.DB.prepare("INSERT INTO friendships (user_low, user_high, created_at) VALUES (?, ?, ?)")
    .bind(low, high, Math.floor(Date.now() / 1000)).run();
}

describe("friends list + unfriend", () => {
  it("lists friends with cards and last_seen_at", async () => {
    const a = await createTestAccount();
    const b = await createTestAccount({ handle: `pal${Date.now() % 100000}` });
    await befriend(a.userId, b.userId);
    await env.DB.prepare("UPDATE users SET last_seen_at = 1751900000 WHERE id = ?").bind(b.userId).run();
    const token = await issueTestSession(a);
    const res = await authed("/social/friends", token);
    expect(res.status).toBe(200);
    const list = (await res.json()) as any[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: b.userId, display_name: b.login, last_seen_at: 1751900000 });
  });

  it("returns an empty list for a user with no friends", async () => {
    const a = await createTestAccount();
    const token = await issueTestSession(a);
    const res = await authed("/social/friends", token);
    expect(res.status).toBe(200);
    const list = (await res.json()) as any[];
    expect(list).toEqual([]);
  });

  it("shows a friend added on EITHER side of the canonical pair", async () => {
    // Pins the CASE join: `me` must surface friends whether it sits in
    // user_low or user_high. createTestAccount ids sort by creation order, so
    // creating one friend BEFORE me and one AFTER forces both orientations:
    // (lowFriend < me) puts me in user_high; (me < highFriend) puts me in user_low.
    const lowFriend = await createTestAccount();
    const me = await createTestAccount();
    const highFriend = await createTestAccount();
    // Guard the fixture assumption so a helpers.ts change can't silently
    // collapse this back to a single orientation.
    expect(lowFriend.userId < me.userId).toBe(true);
    expect(me.userId < highFriend.userId).toBe(true);
    await befriend(me.userId, lowFriend.userId);
    await befriend(me.userId, highFriend.userId);
    const token = await issueTestSession(me);
    const res = await authed("/social/friends", token);
    expect(res.status).toBe(200);
    const list = (await res.json()) as any[];
    const ids = list.map((f) => f.id).sort();
    expect(ids).toEqual([lowFriend.userId, highFriend.userId].sort());
  });

  it("unfriend removes the row regardless of pair order and is silent", async () => {
    const a = await createTestAccount();
    const b = await createTestAccount();
    await befriend(a.userId, b.userId);
    const token = await issueTestSession(a);
    const res = await authed(`/social/friends/${b.userId}`, token, { method: "DELETE" });
    expect(res.status).toBe(200);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM friendships").first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it("unfriend works when me is the user_high side of the pair", async () => {
    // Creation order forces other < me, so the friendship row stores me as
    // user_high — pins pairKey canonicalization in the DELETE route.
    const other = await createTestAccount();
    const me = await createTestAccount();
    expect(other.userId < me.userId).toBe(true);
    await befriend(me.userId, other.userId);
    const token = await issueTestSession(me);
    const res = await authed(`/social/friends/${other.userId}`, token, { method: "DELETE" });
    expect(res.status).toBe(200);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM friendships").first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it("unfriending a non-friend 404s", async () => {
    const a = await createTestAccount();
    const b = await createTestAccount();
    const token = await issueTestSession(a);
    const res = await authed(`/social/friends/${b.userId}`, token, { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
