import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createTestAccount } from "./helpers";

describe("0004_social schema", () => {
  it("friendships enforces user_low < user_high", async () => {
    const a = await createTestAccount();
    const b = await createTestAccount();
    const [low, high] = a.userId < b.userId ? [a.userId, b.userId] : [b.userId, a.userId];
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("INSERT INTO friendships (user_low, user_high, created_at) VALUES (?, ?, ?)")
      .bind(low, high, now).run();
    // Reversed order violates the CHECK constraint
    await expect(
      env.DB.prepare("INSERT INTO friendships (user_low, user_high, created_at) VALUES (?, ?, ?)")
        .bind(high, low, now).run()
    ).rejects.toThrow();
  });

  it("deleting a user cascades friendships, requests, and blocks", async () => {
    const a = await createTestAccount();
    const b = await createTestAccount();
    const now = Math.floor(Date.now() / 1000);
    const [low, high] = a.userId < b.userId ? [a.userId, b.userId] : [b.userId, a.userId];
    await env.DB.batch([
      env.DB.prepare("INSERT INTO friendships (user_low, user_high, created_at) VALUES (?, ?, ?)").bind(low, high, now),
      env.DB.prepare("INSERT INTO friend_requests (id, from_user, to_user, created_at) VALUES ('freq_t1', ?, ?, ?)").bind(a.userId, b.userId, now),
      env.DB.prepare("INSERT INTO blocks (blocker, blocked, created_at) VALUES (?, ?, ?)").bind(a.userId, b.userId, now),
    ]);
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(a.userId).run();
    for (const [table, col] of [["friendships", "user_low"], ["friendships", "user_high"], ["friend_requests", "from_user"], ["blocks", "blocker"]] as const) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).bind(a.userId).first<{ n: number }>();
      expect(row!.n).toBe(0);
    }
  });

  it("users has a nullable last_seen_at column", async () => {
    const a = await createTestAccount();
    await env.DB.prepare("UPDATE users SET last_seen_at = 123 WHERE id = ?").bind(a.userId).run();
    const row = await env.DB.prepare("SELECT last_seen_at FROM users WHERE id = ?").bind(a.userId).first<{ last_seen_at: number }>();
    expect(row!.last_seen_at).toBe(123);
  });

  it("handle_releases has a nullable released_by that clears when the user is deleted", async () => {
    const a = await createTestAccount();
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("INSERT INTO handle_releases (handle, released_at, released_by) VALUES ('oldname', ?, ?)")
      .bind(now, a.userId).run();
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(a.userId).run();
    const row = await env.DB.prepare("SELECT released_by FROM handle_releases WHERE handle = 'oldname'").first<{ released_by: string | null }>();
    expect(row!.released_by).toBeNull(); // ON DELETE SET NULL
  });
});
