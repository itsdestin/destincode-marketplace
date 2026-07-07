// GitHub OAuth device-code flow routes.
//
// Flow:
//   1. POST /auth/github/start           — app creates device_code + user_code + csrf_state
//   2. GET  /auth/github/start-redirect  — browser hits this, gets an HttpOnly
//                                          `oauth_csrf` cookie bound to csrf_state,
//                                          then 302s to GitHub's authorize URL
//   3. GET  /auth/github/callback        — GitHub redirects here with code + state;
//                                          server verifies the cookie matches state,
//                                          exchanges code, stores authorized_user_id
//   4. POST /auth/github/poll            — app polls; when authorized_user_id is set,
//                                          server atomically claims the row, issues a
//                                          fresh session, and returns the raw token
//
// Two hardening properties over the previous design:
//   - `state` is a dedicated random value (not `user_code`) verified against an
//     HttpOnly cookie → attacker can't CSRF the callback, because the victim's
//     browser doesn't hold the attacker's cookie.
//   - Session token is issued at poll time, not stashed in the DB between
//     callback and poll. A crash or unclaimed poll leaves zero secrets at rest.
//
// device_codes.session_token_hash was dropped in migration 0003 (accounts
// rebuild) — it had been unwritten since session issuance moved to poll time.

import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { randomToken, randomUserCode, constantTimeEqual } from "../lib/crypto";
import { badRequest, notFound, unauthorized } from "../lib/errors";
import { buildAuthorizeUrl, exchangeCode, fetchGitHubUser } from "./github";
import { issueSession, revokeSession } from "./sessions";
import { requireAuth } from "./middleware";
import { resolveProviderSignIn } from "../db";

// "Who am I" shape returned in the poll completion payload and by GET /auth/me.
// `login` stays the GitHub login for player-tag continuity (Phase 0 games use
// it); display_name/handle are the account-native fields Phase 2 switches to.
interface MeResponse {
  id: string;
  login: string;
  display_name: string;
  avatar_url: string | null;
  handle: string | null;
}

async function fetchMe(db: HonoEnv["Bindings"]["DB"], userId: string): Promise<MeResponse | null> {
  const row = await db
    .prepare(
      `SELECT u.id, u.display_name, u.avatar_url, u.handle,
              (SELECT provider_login FROM identities i
                WHERE i.user_id = u.id AND i.provider = 'github') AS github_login
       FROM users u WHERE u.id = ?`
    )
    .bind(userId)
    .first<{ id: string; display_name: string; avatar_url: string | null; handle: string | null; github_login: string | null }>();
  if (!row) return null;
  return {
    id: row.id,
    login: row.github_login ?? row.display_name, // non-GitHub accounts fall back
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    handle: row.handle,
  };
}

const DEVICE_CODE_TTL_SEC = 900; // 15 min
const CSRF_COOKIE_NAME = "oauth_csrf";

export const authRoutes = new Hono<HonoEnv>();

authRoutes.post("/auth/github/start", async (c) => {
  const deviceCode = randomToken(32);
  const userCode = randomUserCode();
  const csrfState = randomToken(32);
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB
    .prepare(
      `INSERT INTO device_codes (device_code, user_code, csrf_state, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(deviceCode, userCode, csrfState, now + DEVICE_CODE_TTL_SEC, now)
    .run();
  const origin = new URL(c.req.url).origin;
  const authUrl = `${origin}/auth/github/start-redirect?user_code=${encodeURIComponent(userCode)}`;
  return c.json({ device_code: deviceCode, user_code: userCode, auth_url: authUrl, expires_in: DEVICE_CODE_TTL_SEC });
});

authRoutes.get("/auth/github/start-redirect", async (c) => {
  const userCode = c.req.query("user_code");
  if (!userCode) throw badRequest("missing user_code");

  // Look up csrf_state for this user_code — we can't trust the query to supply
  // it since this URL is what the user opens; we want the state value to come
  // from the server row, not the URL.
  const row = await c.env.DB
    .prepare("SELECT csrf_state, expires_at FROM device_codes WHERE user_code = ?")
    .bind(userCode)
    .first<{ csrf_state: string | null; expires_at: number }>();
  if (!row || !row.csrf_state) throw notFound("unknown user_code");
  if (row.expires_at < Math.floor(Date.now() / 1000)) throw badRequest("expired");

  const callback = `${new URL(c.req.url).origin}/auth/github/callback`;
  const authorizeUrl = buildAuthorizeUrl(c.env.GH_CLIENT_ID, row.csrf_state, callback);

  // Set an HttpOnly cookie bound to this browser. On callback we require the
  // cookie to match the `state` query param — this is what actually prevents
  // the login-CSRF attack. SameSite=Lax allows the cookie on the top-level
  // redirect back from GitHub.
  c.header(
    "Set-Cookie",
    `${CSRF_COOKIE_NAME}=${row.csrf_state}; Path=/auth/github/callback; Max-Age=${DEVICE_CODE_TTL_SEC}; HttpOnly; Secure; SameSite=Lax`
  );
  return c.redirect(authorizeUrl);
});

authRoutes.get("/auth/github/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) throw badRequest("missing code or state");

  // Pull the CSRF cookie and verify it matches the state GitHub echoed back.
  // Without this, an attacker who started their own OAuth flow could trick a
  // victim's browser into completing the callback, hijacking the app to their
  // GitHub account (or vice versa).
  const cookieHeader = c.req.header("Cookie") ?? "";
  const cookieState = parseCookie(cookieHeader, CSRF_COOKIE_NAME);
  if (!cookieState || !constantTimeEqual(cookieState, state)) {
    throw badRequest("csrf check failed");
  }

  const dcRow = await c.env.DB
    .prepare(
      "SELECT device_code, expires_at, authorized_user_id FROM device_codes WHERE csrf_state = ?"
    )
    .bind(state)
    .first<{ device_code: string; expires_at: number; authorized_user_id: string | null }>();
  if (!dcRow) throw notFound("unknown state");
  if (dcRow.expires_at < Math.floor(Date.now() / 1000)) throw badRequest("expired");
  // Idempotent: a duplicate GitHub callback (user hits back, retries) shouldn't
  // re-run the code exchange — GitHub codes are single-use and would 400.
  if (dcRow.authorized_user_id) {
    return c.html("<h1>Already authorized — you can close this window.</h1>");
  }

  const accessToken = await exchangeCode(c.env.GH_CLIENT_ID, c.env.GH_CLIENT_SECRET, code);
  const gh = await fetchGitHubUser(accessToken);
  // Identity-based resolution: same GitHub user → same account across sign-ins.
  const userId = await resolveProviderSignIn(c.env.DB, "github", String(gh.id), {
    login: gh.login,
    avatar_url: gh.avatar_url,
  });

  // Store only the user_id. The session token is issued at poll time so no raw
  // bearer ever sits in D1.
  await c.env.DB
    .prepare("UPDATE device_codes SET authorized_user_id = ? WHERE csrf_state = ?")
    .bind(userId, state)
    .run();

  // Clear the CSRF cookie now that it's served its purpose.
  c.header(
    "Set-Cookie",
    `${CSRF_COOKIE_NAME}=; Path=/auth/github/callback; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
  );
  return c.html(
    `<h1>Signed in as ${gh.login}</h1><p>You can close this window and return to YouCoded.</p>`
  );
});

authRoutes.post("/auth/github/poll", async (c) => {
  const body = await c.req.json<{ device_code?: string }>();
  if (!body.device_code) throw badRequest("missing device_code");

  const row = await c.env.DB
    .prepare(
      "SELECT authorized_user_id, expires_at FROM device_codes WHERE device_code = ?"
    )
    .bind(body.device_code)
    .first<{ authorized_user_id: string | null; expires_at: number }>();
  if (!row) throw notFound("unknown device_code");
  if (row.expires_at < Math.floor(Date.now() / 1000)) {
    await c.env.DB.prepare("DELETE FROM device_codes WHERE device_code = ?").bind(body.device_code).run();
    throw badRequest("expired");
  }
  if (!row.authorized_user_id) return c.json({ status: "pending" }, 202);

  // Atomically claim the row: only the first poll that wins the DELETE gets to
  // issue the session. Duplicate/retried polls see no row and return pending,
  // so a replay can't get a second token.
  const claim = await c.env.DB
    .prepare(
      "DELETE FROM device_codes WHERE device_code = ? AND authorized_user_id IS NOT NULL RETURNING authorized_user_id"
    )
    .bind(body.device_code)
    .first<{ authorized_user_id: string }>();
  if (!claim) return c.json({ status: "pending" }, 202);

  const token = await issueSession(c.env.DB, claim.authorized_user_id);
  // Include the user profile so clients can store token + profile atomically.
  // Android already reads an optional `user` field here; desktop now does too.
  const user = await fetchMe(c.env.DB, claim.authorized_user_id);
  return c.json({ status: "complete", token, user });
});

// POST /auth/logout — server-side revocation of the presented session. The
// client also clears its local token; this closes the "sign out only deleted
// the local copy, D1 row lived forever" gap.
authRoutes.post("/auth/logout", async (c) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) throw unauthorized();
  await revokeSession(c.env.DB, header.slice(7));
  return c.body(null, 204);
});

// GET /auth/me — resolve the presented session token to the user's profile.
// Used by clients to lazily heal a stored token that predates profile storage
// (sign-ins before 2026-07 stored only the token).
authRoutes.get("/auth/me", requireAuth, async (c) => {
  const me = await fetchMe(c.env.DB, c.get("userId"));
  // A valid session pointing at a missing user row means the account was
  // deleted out from under the session — treat as signed out.
  if (!me) throw unauthorized("unknown user");
  return c.json(me);
});

function parseCookie(header: string, name: string): string | null {
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}
