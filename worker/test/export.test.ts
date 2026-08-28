import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createTestAccount, issueTestSession } from "./helpers";

describe("GET /auth/export", () => {
  it("returns every owner-visible row and nothing else", async () => {
    const me = await createTestAccount({ handle: `ex${Date.now() % 100000}` });
    const friend = await createTestAccount();
    const blockedByMe = await createTestAccount();
    const blockerOfMe = await createTestAccount();
    const now = Math.floor(Date.now() / 1000);
    const [low, high] = me.userId < friend.userId ? [me.userId, friend.userId] : [friend.userId, me.userId];
    await env.DB.batch([
      env.DB.prepare("INSERT INTO friendships (user_low, user_high, created_at) VALUES (?, ?, ?)").bind(low, high, now),
      env.DB.prepare("INSERT INTO blocks (blocker, blocked, created_at) VALUES (?, ?, ?)").bind(me.userId, blockedByMe.userId, now),
      env.DB.prepare("INSERT INTO blocks (blocker, blocked, created_at) VALUES (?, ?, ?)").bind(blockerOfMe.userId, me.userId, now),
      // installs column is `installed_at` (migration 0003), not `created_at`.
      env.DB.prepare("INSERT INTO installs (user_id, plugin_id, installed_at) VALUES (?, 'test-plugin', ?)").bind(me.userId, now),
    ]);
    const token = await issueTestSession(me);
    const res = await SELF.fetch("https://test.local/auth/export", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.account.id).toBe(me.userId);
    expect(data.identities).toHaveLength(1);
    expect(data.friendships).toHaveLength(1);
    expect(data.blocks).toHaveLength(1);
    expect(data.blocks[0].blocked).toBe(blockedByMe.userId);
    // NEVER exposes who blocked me
    expect(JSON.stringify(data)).not.toContain(blockerOfMe.userId);
    expect(data.installs).toHaveLength(1);
    // sessions carry timestamps only, no token material
    expect(JSON.stringify(data.sessions)).not.toContain("token");
  });

  it("carries the caller's thumbs and comments, including comments held for review", async () => {
    // GET /auth/export pins its column list per table and requires every new
    // user-owned table to OPT IN. Two arrived with the feedback feature — and a
    // comment is free text the user wrote, the most personal data here. A hidden
    // comment is still theirs: seeing `hidden: 1` is how they learn it was held.
    const account = await createTestAccount({ login: "exporter" });
    const token = await issueTestSession(account);
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("INSERT INTO thumbs (user_id, plugin_id, vote, created_at, updated_at) VALUES (?, 'p1', 1, ?, ?)")
      .bind(account.userId, now, now).run();
    await env.DB.prepare("INSERT INTO comments (id, user_id, plugin_id, text, created_at, hidden) VALUES ('c1', ?, 'p1', 'mine', ?, 0)")
      .bind(account.userId, now).run();
    await env.DB.prepare("INSERT INTO comments (id, user_id, plugin_id, text, created_at, hidden) VALUES ('c2', ?, 'p1', 'held', ?, 1)")
      .bind(account.userId, now).run();
    // Someone else's rows must not leak into this export.
    const other = await createTestAccount({ login: "other" });
    await env.DB.prepare("INSERT INTO comments (id, user_id, plugin_id, text, created_at, hidden) VALUES ('c3', ?, 'p1', 'theirs', ?, 0)")
      .bind(other.userId, now).run();

    const res = await SELF.fetch("https://test.local/auth/export", { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json<{
      thumbs: Array<{ plugin_id: string; vote: number }>;
      comments: Array<{ id: string; text: string; hidden: number }>;
    }>();
    expect(body.thumbs).toEqual([expect.objectContaining({ plugin_id: "p1", vote: 1 })]);
    expect(body.comments.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
    expect(body.comments.find((c) => c.id === "c2")!.hidden).toBe(1);
  });

  it("surfaces pending friend requests in both directions with the other party's id", async () => {
    const me = await createTestAccount();
    const sender = await createTestAccount();
    const recipient = await createTestAccount();
    const now = Math.floor(Date.now() / 1000);
    await env.DB.batch([
      // Incoming: sender -> me
      env.DB.prepare("INSERT INTO friend_requests (id, from_user, to_user, created_at) VALUES (?, ?, ?, ?)")
        .bind(`freq_in_${me.userId}`, sender.userId, me.userId, now),
      // Outgoing: me -> recipient
      env.DB.prepare("INSERT INTO friend_requests (id, from_user, to_user, created_at) VALUES (?, ?, ?, ?)")
        .bind(`freq_out_${me.userId}`, me.userId, recipient.userId, now),
    ]);
    const token = await issueTestSession(me);
    const res = await SELF.fetch("https://test.local/auth/export", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.friend_requests.incoming).toHaveLength(1);
    expect(data.friend_requests.incoming[0].from_user).toBe(sender.userId);
    expect(data.friend_requests.outgoing).toHaveLength(1);
    expect(data.friend_requests.outgoing[0].to_user).toBe(recipient.userId);
  });

  it("requires a session", async () => {
    const res = await SELF.fetch("https://test.local/auth/export");
    expect(res.status).toBe(401);
  });
});
