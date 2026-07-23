import type { D1Database } from "@cloudflare/workers-types";
import { randomToken } from "./lib/crypto";

// Resolve a provider sign-in to an account id, creating account + identity on
// first sign-in (spec §1). The provider profile refreshes avatar_url and
// provider_login on EVERY sign-in; display_name is seeded once at creation and
// then owned by the user (PATCH /auth/profile) — never clobbered here.
export async function resolveProviderSignIn(
  db: D1Database,
  provider: string,
  providerUserId: string,
  profile: { login: string; avatar_url: string | null }
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const existing = await db
    .prepare("SELECT user_id FROM identities WHERE provider = ? AND provider_user_id = ?")
    .bind(provider, providerUserId)
    .first<{ user_id: string }>();
  if (existing) {
    await db.prepare("UPDATE identities SET provider_login = ? WHERE provider = ? AND provider_user_id = ?")
      .bind(profile.login, provider, providerUserId).run();
    await db.prepare("UPDATE users SET avatar_url = ? WHERE id = ?")
      .bind(profile.avatar_url, existing.user_id).run();
    return existing.user_id;
  }
  // First sign-in: create account + identity. Two concurrent first sign-ins
  // from the SAME provider user can both reach here (both saw no identity row
  // above). Without care, the loser would 500 on the identities PK conflict
  // and leave an orphaned users row. D1 has no interactive transactions, so:
  //   1. run both INSERTs atomically via db.batch, with the identities insert
  //      as ON CONFLICT DO NOTHING (the loser's identity insert is a no-op);
  //   2. re-read the identity row — whoever's insert stuck owns the account;
  //   3. if a racer won, delete OUR users row (it's the orphan — nothing
  //      references it, since our identity insert was the no-op) and return
  //      the winner's account id so both sign-ins converge on one account.
  const id = "acct_" + randomToken(16); // 32 hex chars, opaque
  await db.batch([
    db.prepare("INSERT INTO users (id, display_name, avatar_url, created_at) VALUES (?, ?, ?, ?)")
      .bind(id, profile.login, profile.avatar_url, now),
    db.prepare(
      `INSERT INTO identities (provider, provider_user_id, user_id, provider_login, linked_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (provider, provider_user_id) DO NOTHING`
    ).bind(provider, providerUserId, id, profile.login, now),
  ]);
  const resolved = await db
    .prepare("SELECT user_id FROM identities WHERE provider = ? AND provider_user_id = ?")
    .bind(provider, providerUserId)
    .first<{ user_id: string }>();
  if (resolved && resolved.user_id !== id) {
    // A concurrent sign-in won the identity row: our users row is unreferenced.
    await db.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
    return resolved.user_id;
  }
  return id;
}

export async function hasInstall(db: D1Database, userId: string, pluginId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS one FROM installs WHERE user_id = ? AND plugin_id = ?")
    .bind(userId, pluginId)
    .first<{ one: number }>();
  return row !== null;
}
