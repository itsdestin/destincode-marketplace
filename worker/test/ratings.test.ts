import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { createTestAccount, issueTestSession, type TestAccount } from "./helpers";

// Seed an account + real session; return both so tests can install/assert
// against the opaque account id rather than a parseable github: id.
async function seed(): Promise<{ token: string; account: TestAccount }> {
  const account = await createTestAccount({ login: "testy" });
  const token = await issueTestSession(account);
  return { token, account };
}

async function seedInstall(userId: string, pluginId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("INSERT INTO installs (user_id, plugin_id, installed_at) VALUES (?, ?, ?)")
    .bind(userId, pluginId, now).run();
}

describe("POST /ratings", () => {
  beforeEach(async () => {
    for (const t of ["sessions", "identities", "users", "installs", "ratings"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });

  it("403s when the user has not installed the plugin", async () => {
    const { token } = await seed();
    const res = await SELF.fetch("https://test.local/ratings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ plugin_id: "foo:bar", stars: 5 }),
    });
    expect(res.status).toBe(403);
  });

  it("accepts a rating when the user has installed the plugin", async () => {
    const { token, account } = await seed();
    await seedInstall(account.userId, "foo:bar");
    const res = await SELF.fetch("https://test.local/ratings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ plugin_id: "foo:bar", stars: 4, review_text: "solid" }),
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT stars, review_text FROM ratings WHERE user_id = ? AND plugin_id = ?")
      .bind(account.userId, "foo:bar").first<{ stars: number; review_text: string }>();
    expect(row).toEqual({ stars: 4, review_text: "solid" });
  });

  it("updates an existing rating (upsert)", async () => {
    const { token, account } = await seed();
    await seedInstall(account.userId, "foo:bar");
    const post = (body: unknown) => SELF.fetch("https://test.local/ratings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    await post({ plugin_id: "foo:bar", stars: 4, review_text: "solid" });
    await post({ plugin_id: "foo:bar", stars: 2, review_text: "changed my mind" });
    const row = await env.DB.prepare("SELECT stars, review_text FROM ratings WHERE user_id = ? AND plugin_id = ?")
      .bind(account.userId, "foo:bar").first();
    expect(row).toEqual({ stars: 2, review_text: "changed my mind" });
    const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM ratings").all<{ n: number }>();
    expect(results[0]?.n).toBe(1);
  });

  it("rejects stars outside 1-5", async () => {
    const { token, account } = await seed();
    await seedInstall(account.userId, "foo:bar");
    for (const bad of [0, 6, 3.5, -1]) {
      const res = await SELF.fetch("https://test.local/ratings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ plugin_id: "foo:bar", stars: bad }),
      });
      expect(res.status).toBe(400);
    }
  });
});

describe("GET /ratings/:plugin_id", () => {
  beforeEach(async () => {
    for (const t of ["sessions", "identities", "users", "installs", "ratings"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });

  // Helper: insert an account + rating row directly (bypasses install/moderation
  // checks). Returns the opaque account id so callers can assert on it. The
  // account's display_name is seeded from `login`, which is what the ratings
  // join now surfaces as user_login/user_avatar_url.
  async function seedRating(opts: {
    login: string;
    avatarUrl?: string | null;
    pluginId: string;
    stars: number;
    reviewText?: string | null;
    hidden?: number;
    createdAt?: number;
  }): Promise<string> {
    const now = opts.createdAt ?? Math.floor(Date.now() / 1000);
    const account = await createTestAccount({ login: opts.login });
    // createTestAccount seeds avatar_url null; override when the test needs one.
    if (opts.avatarUrl != null) {
      await env.DB.prepare("UPDATE users SET avatar_url = ? WHERE id = ?")
        .bind(opts.avatarUrl, account.userId).run();
    }
    await env.DB
      .prepare(
        `INSERT INTO ratings (user_id, plugin_id, stars, review_text, created_at, updated_at, hidden)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(account.userId, opts.pluginId, opts.stars, opts.reviewText ?? null, now, now, opts.hidden ?? 0)
      .run();
    return account.userId;
  }

  it("returns empty array when plugin has no ratings", async () => {
    const res = await SELF.fetch("https://test.local/ratings/no-such:plugin");
    expect(res.status).toBe(200);
    const body = await res.json() as { ratings: unknown[] };
    expect(body.ratings).toEqual([]);
  });

  it("returns visible ratings with joined user fields", async () => {
    const userId = await seedRating({
      login: "alice",
      avatarUrl: "https://avatars.githubusercontent.com/u/10",
      pluginId: "foo:bar",
      stars: 5,
      reviewText: "love it",
    });

    const res = await SELF.fetch("https://test.local/ratings/foo:bar");
    expect(res.status).toBe(200);
    const body = await res.json() as { ratings: Array<Record<string, unknown>> };
    expect(body.ratings).toHaveLength(1);
    // Non-null assertion is safe: we just asserted length === 1 above.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const r = body.ratings[0]!;
    expect(r.user_id).toBe(userId);
    expect(r.user_login).toBe("alice");
    expect(r.user_avatar_url).toBe("https://avatars.githubusercontent.com/u/10");
    expect(r.stars).toBe(5);
    expect(r.review_text).toBe("love it");
    expect(typeof r.created_at).toBe("number");
    // id is a stable composite key for React list rendering
    expect(r.id).toBe(`${userId}:foo:bar`);
  });

  it("excludes hidden ratings", async () => {
    // Visible rating
    const visibleId = await seedRating({ login: "bob", pluginId: "foo:bar", stars: 4, hidden: 0 });
    // Hidden (moderated) rating
    await seedRating({ login: "mallory", pluginId: "foo:bar", stars: 1, reviewText: "bad content", hidden: 1 });

    const res = await SELF.fetch("https://test.local/ratings/foo:bar");
    const body = await res.json() as { ratings: Array<Record<string, unknown>> };
    // Only the visible one should appear
    expect(body.ratings).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(body.ratings[0]!.user_id).toBe(visibleId);
  });

  it("returns results ordered by created_at DESC (newest first)", async () => {
    const base = Math.floor(Date.now() / 1000);
    await seedRating({ login: "old", pluginId: "p:1", stars: 3, createdAt: base - 200 });
    await seedRating({ login: "newer", pluginId: "p:1", stars: 4, createdAt: base - 100 });
    await seedRating({ login: "newest", pluginId: "p:1", stars: 5, createdAt: base });

    const res = await SELF.fetch("https://test.local/ratings/p:1");
    const body = await res.json() as { ratings: Array<{ user_login: string }> };
    expect(body.ratings.map((r) => r.user_login)).toEqual(["newest", "newer", "old"]);
  });

  it("caps results at 50 rows", async () => {
    // Seed 55 distinct users all rating the same plugin.
    const base = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 55; i++) {
      await seedRating({
        login: `user${i}`,
        pluginId: "cap:test",
        stars: (i % 5) + 1,
        createdAt: base + i,  // distinct timestamps so order is deterministic
      });
    }

    const res = await SELF.fetch("https://test.local/ratings/cap:test");
    const body = await res.json() as { ratings: unknown[] };
    expect(body.ratings).toHaveLength(50);
  });
});

describe("DELETE /ratings/:plugin_id", () => {
  beforeEach(async () => {
    for (const t of ["sessions", "identities", "users", "installs", "ratings"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });

  it("deletes only the caller's rating", async () => {
    const { token: tokenA, account: accountA } = await seed();
    const { token: tokenB, account: accountB } = await seed();
    await seedInstall(accountA.userId, "foo:bar");
    await seedInstall(accountB.userId, "foo:bar");
    const postA = await SELF.fetch("https://test.local/ratings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ plugin_id: "foo:bar", stars: 5 }),
    });
    expect(postA.status).toBe(200);
    const postB = await SELF.fetch("https://test.local/ratings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenB}` },
      body: JSON.stringify({ plugin_id: "foo:bar", stars: 1 }),
    });
    expect(postB.status).toBe(200);

    const del = await SELF.fetch("https://test.local/ratings/foo:bar", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    expect(del.status).toBe(200);

    const { results } = await env.DB.prepare("SELECT user_id FROM ratings").all<{ user_id: string }>();
    expect(results.map(r => r.user_id)).toEqual([accountB.userId]);
  });
});
