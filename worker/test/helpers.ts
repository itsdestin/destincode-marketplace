// Shared fixtures for the accounts schema. New tests should use these helpers
// rather than hand-rolling INSERTs into users/identities — schema drift then
// breaks every file at once. Authenticated callers (especially admins, whose
// github identity id must match ADMIN_USER_IDS) go through createTestAccount +
// issueTestSession. Some tests still INSERT plain user rows directly, but only
// as opaque foreign-key targets (rating/install owners, stats data) — never as
// callers — so they need no session or identity.
import { env, SELF } from "cloudflare:test";

let seq = 0;

export interface TestAccount {
  userId: string;
  githubId: string;
  login: string;
}

/** Insert an account + github identity directly. */
export async function createTestAccount(opts?: { login?: string; githubId?: string; handle?: string }): Promise<TestAccount> {
  seq += 1;
  const login = opts?.login ?? `user${seq}`;
  const githubId = opts?.githubId ?? String(1000 + seq);
  const userId = `acct_test${String(seq).padStart(4, "0")}${"0".repeat(20)}`;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("INSERT INTO users (id, display_name, avatar_url, handle, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(userId, login, null, opts?.handle ?? null, now).run();
  await env.DB.prepare("INSERT INTO identities (provider, provider_user_id, user_id, provider_login, linked_at) VALUES ('github', ?, ?, ?, ?)")
    .bind(githubId, userId, login, now).run();
  return { userId, githubId, login };
}

/** Complete a device-code flow for an existing account; returns the session token. */
export async function issueTestSession(account: TestAccount): Promise<string> {
  const start = await SELF.fetch("https://test.local/auth/github/start", { method: "POST" });
  const { device_code, user_code } = await start.json() as { device_code: string; user_code: string };
  await env.DB.prepare("UPDATE device_codes SET authorized_user_id = ? WHERE user_code = ?")
    .bind(account.userId, user_code).run();
  const poll = await SELF.fetch("https://test.local/auth/github/poll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_code }),
  });
  // Fail loudly here: a broken fixture flow otherwise surfaces as a confusing
  // downstream 401 in whichever test consumed the (undefined) token.
  if (!poll.ok) {
    throw new Error(`issueTestSession: poll failed with ${poll.status}: ${await poll.text()}`);
  }
  const { token } = await poll.json() as { token: string };
  return token;
}
