import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createTestAccount, issueTestSession } from "./helpers";

async function authed(path: string, token: string, init?: RequestInit) {
  return SELF.fetch(`https://test.local${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  });
}

describe("PATCH /auth/profile", () => {
  it("updates display_name", async () => {
    const acct = await createTestAccount({ login: "octo" });
    const token = await issueTestSession(acct);
    const res = await authed("/auth/profile", token, { method: "PATCH", body: JSON.stringify({ display_name: "Octo Prime" }) });
    expect(res.status).toBe(200);
    const me = await (await authed("/auth/me", token)).json() as { display_name: string };
    expect(me.display_name).toBe("Octo Prime");
  });

  it("rejects empty and over-long names", async () => {
    const acct = await createTestAccount();
    const token = await issueTestSession(acct);
    for (const bad of ["", "   ", "x".repeat(61)]) {
      const res = await authed("/auth/profile", token, { method: "PATCH", body: JSON.stringify({ display_name: bad }) });
      expect(res.status).toBe(400);
    }
  });
});

describe("PUT /auth/handle", () => {
  it("sets a handle (lowercased) and returns it from /auth/me", async () => {
    const acct = await createTestAccount();
    const token = await issueTestSession(acct);
    const res = await authed("/auth/handle", token, { method: "PUT", body: JSON.stringify({ handle: "Dest-In1" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ handle: "dest-in1" });
    const me = await (await authed("/auth/me", token)).json() as { handle: string };
    expect(me.handle).toBe("dest-in1");
  });

  it("rejects invalid formats and reserved names", async () => {
    const acct = await createTestAccount();
    const token = await issueTestSession(acct);
    for (const bad of ["ab", "-lead", "sp ace", "ünïcode", "x".repeat(31), "youcoded", "admin"]) {
      const res = await authed("/auth/handle", token, { method: "PUT", body: JSON.stringify({ handle: bad }) });
      expect(res.status, `handle ${JSON.stringify(bad)}`).toBe(400);
    }
  });

  it("refuses a handle already taken (409)", async () => {
    await createTestAccount({ handle: "taken" });
    const b = await createTestAccount();
    const token = await issueTestSession(b);
    const res = await authed("/auth/handle", token, { method: "PUT", body: JSON.stringify({ handle: "taken" }) });
    expect(res.status).toBe(409);
  });

  it("re-PUTting the current handle is a 200 no-op with no cooldown release", async () => {
    // A spurious handle_releases row here would cooldown-lock a handle that
    // was never actually freed — the user still owns it.
    const acct = await createTestAccount({ handle: "keeper" });
    const token = await issueTestSession(acct);
    const res = await authed("/auth/handle", token, { method: "PUT", body: JSON.stringify({ handle: "keeper" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ handle: "keeper" });
    const rel = await env.DB.prepare("SELECT handle FROM handle_releases WHERE handle = 'keeper'").first();
    expect(rel).toBeNull();
  });

  it("puts the old handle into a 30-day cooldown on rename, and refuses cooldown handles", async () => {
    const a = await createTestAccount();
    const tokenA = await issueTestSession(a);
    await authed("/auth/handle", tokenA, { method: "PUT", body: JSON.stringify({ handle: "first" }) });
    await authed("/auth/handle", tokenA, { method: "PUT", body: JSON.stringify({ handle: "second" }) });

    const rel = await env.DB.prepare("SELECT handle FROM handle_releases WHERE handle = 'first'").first();
    expect(rel).not.toBeNull();

    const b = await createTestAccount();
    const tokenB = await issueTestSession(b);
    const res = await authed("/auth/handle", tokenB, { method: "PUT", body: JSON.stringify({ handle: "first" }) });
    expect(res.status).toBe(409); // cooldown
  });
});

describe("DELETE /auth/account", () => {
  it("hard-deletes the account and cascades everything", async () => {
    const acct = await createTestAccount({ handle: "goodbye" });
    const token = await issueTestSession(acct);
    const now = Math.floor(Date.now() / 1000);
    // Seed rows in every cascading table
    await env.DB.prepare("INSERT INTO installs (user_id, plugin_id, installed_at) VALUES (?, 'p1', ?)").bind(acct.userId, now).run();
    await env.DB.prepare("INSERT INTO ratings (user_id, plugin_id, stars, created_at, updated_at) VALUES (?, 'p1', 5, ?, ?)").bind(acct.userId, now, now).run();
    await env.DB.prepare("INSERT INTO theme_likes (user_id, theme_id, liked_at) VALUES (?, 't1', ?)").bind(acct.userId, now).run();

    const res = await authed("/auth/account", token, { method: "DELETE" });
    expect(res.status).toBe(204);

    for (const [table, col] of [["users", "id"], ["identities", "user_id"], ["sessions", "user_id"], ["installs", "user_id"], ["ratings", "user_id"], ["theme_likes", "user_id"]] as const) {
      const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${col} = ?`).bind(acct.userId).first<{ n: number }>();
      expect(row!.n, table).toBe(0);
    }
    // The freed handle enters cooldown
    const rel = await env.DB.prepare("SELECT 1 AS one FROM handle_releases WHERE handle = 'goodbye'").first();
    expect(rel).not.toBeNull();
    // The presented token is dead (its session row cascaded)
    const me = await authed("/auth/me", token);
    expect(me.status).toBe(401);
  });

  it("deletes an account with no handle without creating a release row", async () => {
    const acct = await createTestAccount(); // handle stays NULL
    const token = await issueTestSession(acct);
    // Count before/after so the assertion is robust to rows other tests seeded.
    const before = await env.DB.prepare("SELECT count(*) AS n FROM handle_releases").first<{ n: number }>();

    const res = await authed("/auth/account", token, { method: "DELETE" });
    expect(res.status).toBe(204);

    const gone = await env.DB.prepare("SELECT count(*) AS n FROM users WHERE id = ?").bind(acct.userId).first<{ n: number }>();
    expect(gone!.n).toBe(0);
    const after = await env.DB.prepare("SELECT count(*) AS n FROM handle_releases").first<{ n: number }>();
    expect(after!.n).toBe(before!.n); // no handle → no cooldown row
  });
});
