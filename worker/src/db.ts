import type { D1Database } from "@cloudflare/workers-types";
import type { RatingRow } from "./types";
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
  const id = "acct_" + randomToken(16); // 32 hex chars, opaque
  await db.prepare("INSERT INTO users (id, display_name, avatar_url, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, profile.login, profile.avatar_url, now).run();
  await db.prepare("INSERT INTO identities (provider, provider_user_id, user_id, provider_login, linked_at) VALUES (?, ?, ?, ?, ?)")
    .bind(provider, providerUserId, id, profile.login, now).run();
  return id;
}

export async function hasInstall(db: D1Database, userId: string, pluginId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS one FROM installs WHERE user_id = ? AND plugin_id = ?")
    .bind(userId, pluginId)
    .first<{ one: number }>();
  return row !== null;
}

export async function getRating(
  db: D1Database,
  userId: string,
  pluginId: string
): Promise<RatingRow | null> {
  return await db
    .prepare("SELECT * FROM ratings WHERE user_id = ? AND plugin_id = ?")
    .bind(userId, pluginId)
    .first<RatingRow>();
}
