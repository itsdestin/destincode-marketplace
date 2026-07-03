import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("POST /auth/github/start", () => {
  it("returns a device_code, user_code, and auth URL", async () => {
    const res = await SELF.fetch("https://test.local/auth/github/start", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as { device_code: string; user_code: string; auth_url: string; expires_in: number };
    expect(body.device_code).toMatch(/^[0-9a-f]{64}$/);
    expect(body.user_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    // Plan's /auth/github/start returns a URL pointing at our own /start-redirect
    // page (which sets the CSRF cookie and 302s to GitHub). So we assert against
    // the actual returned string.
    expect(body.auth_url).toContain("/auth/github/start-redirect");
    expect(body.expires_in).toBe(900);
  });

  it("persists the device_code with a csrf_state in the database", async () => {
    const res = await SELF.fetch("https://test.local/auth/github/start", { method: "POST" });
    const { device_code } = await res.json() as { device_code: string };
    const row = await env.DB.prepare("SELECT device_code, csrf_state FROM device_codes WHERE device_code = ?")
      .bind(device_code).first<{ device_code: string; csrf_state: string }>();
    expect(row).not.toBeNull();
    expect(row!.csrf_state).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("POST /auth/github/poll", () => {
  it("returns pending when the device code is not yet completed", async () => {
    const start = await SELF.fetch("https://test.local/auth/github/start", { method: "POST" });
    const { device_code } = await start.json() as { device_code: string };

    const poll = await SELF.fetch("https://test.local/auth/github/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code }),
    });
    expect(poll.status).toBe(202);
    expect(await poll.json()).toEqual({ status: "pending" });
  });

  it("returns complete + a freshly issued session token once authorized_user_id is set", async () => {
    const start = await SELF.fetch("https://test.local/auth/github/start", { method: "POST" });
    const { device_code, user_code } = await start.json() as { device_code: string; user_code: string };

    // Simulate the callback having completed: a user row exists and the
    // device_codes row has authorized_user_id set. This bypasses GitHub.
    const now = Math.floor(Date.now() / 1000);
    await env.DB
      .prepare("INSERT INTO users (id, github_login, github_avatar_url, created_at) VALUES (?, ?, ?, ?)")
      .bind("github:123", "octocat", "https://avatars.example/octocat.png", now)
      .run();
    await env.DB
      .prepare("UPDATE device_codes SET authorized_user_id = ? WHERE user_code = ?")
      .bind("github:123", user_code)
      .run();

    const poll = await SELF.fetch("https://test.local/auth/github/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code }),
    });
    expect(poll.status).toBe(200);
    const body = await poll.json() as { status: string; token: string; user: { id: string; login: string; avatar_url: string | null } };
    expect(body.status).toBe("complete");
    // Token is freshly issued at poll time (64 hex chars from randomToken(32))
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    // The completion payload carries the user profile so clients can store
    // token + profile together (games player tag needs `login`).
    expect(body.user).toEqual({ id: "github:123", login: "octocat", avatar_url: "https://avatars.example/octocat.png" });

    // device_codes row should be deleted so the token can't be re-claimed
    const row = await env.DB.prepare("SELECT 1 FROM device_codes WHERE device_code = ?")
      .bind(device_code).first();
    expect(row).toBeNull();

    // A replay of the same poll now returns pending (row gone), not a second token
    const replay = await SELF.fetch("https://test.local/auth/github/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code }),
    });
    expect(replay.status).toBe(404);
  });
});

describe("GET /auth/me", () => {
  // Helper: complete a device-code flow and return the issued session token.
  async function signIn(userId: string, login: string): Promise<string> {
    const start = await SELF.fetch("https://test.local/auth/github/start", { method: "POST" });
    const { device_code, user_code } = await start.json() as { device_code: string; user_code: string };
    const now = Math.floor(Date.now() / 1000);
    await env.DB
      .prepare("INSERT OR IGNORE INTO users (id, github_login, created_at) VALUES (?, ?, ?)")
      .bind(userId, login, now)
      .run();
    await env.DB
      .prepare("UPDATE device_codes SET authorized_user_id = ? WHERE user_code = ?")
      .bind(userId, user_code)
      .run();
    const poll = await SELF.fetch("https://test.local/auth/github/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code }),
    });
    const { token } = await poll.json() as { token: string };
    return token;
  }

  it("returns the signed-in user's profile for a valid session token", async () => {
    const token = await signIn("github:456", "hubot");
    const res = await SELF.fetch("https://test.local/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "github:456", login: "hubot", avatar_url: null });
  });

  it("returns 401 without a token or with an invalid token", async () => {
    const bare = await SELF.fetch("https://test.local/auth/me");
    expect(bare.status).toBe(401);
    const bad = await SELF.fetch("https://test.local/auth/me", {
      headers: { Authorization: "Bearer 0000000000000000000000000000000000000000000000000000000000000000" },
    });
    expect(bad.status).toBe(401);
  });
});

describe("GET /auth/github/callback CSRF protection", () => {
  it("rejects the callback when the state cookie is missing", async () => {
    const start = await SELF.fetch("https://test.local/auth/github/start", { method: "POST" });
    const { user_code } = await start.json() as { user_code: string };
    const { csrf_state } = (await env.DB
      .prepare("SELECT csrf_state FROM device_codes WHERE user_code = ?")
      .bind(user_code)
      .first<{ csrf_state: string }>())!;

    // No Cookie header — simulates a callback arriving at a browser that never
    // visited /start-redirect (i.e., a cross-site login-CSRF attempt).
    const res = await SELF.fetch(
      `https://test.local/auth/github/callback?code=anything&state=${encodeURIComponent(csrf_state)}`
    );
    expect(res.status).toBe(400);
  });

  it("rejects the callback when the state query doesn't match the cookie", async () => {
    const start = await SELF.fetch("https://test.local/auth/github/start", { method: "POST" });
    const { user_code } = await start.json() as { user_code: string };
    const { csrf_state } = (await env.DB
      .prepare("SELECT csrf_state FROM device_codes WHERE user_code = ?")
      .bind(user_code)
      .first<{ csrf_state: string }>())!;

    const res = await SELF.fetch(
      `https://test.local/auth/github/callback?code=anything&state=${encodeURIComponent(csrf_state)}`,
      { headers: { Cookie: "oauth_csrf=some-other-value" } }
    );
    expect(res.status).toBe(400);
  });
});
