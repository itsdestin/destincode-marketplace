// Admin allowlist, keyed on the GitHub identity (numeric id) via `identities`
// — NOT on account ids, so it survives id-format changes (spec §1).
// ADMIN_USER_IDS: comma-separated GitHub numeric ids.
import type { D1Database } from "@cloudflare/workers-types";

export async function isAdminAccount(
  db: D1Database,
  env: { ADMIN_USER_IDS: string },
  userId: string
): Promise<boolean> {
  const admins = env.ADMIN_USER_IDS.split(",").map((s) => s.trim()).filter(Boolean);
  if (admins.length === 0) return false;
  // Look up the caller's github identity and check its numeric id against the
  // allowlist. An account with no github identity (or an unknown userId) yields
  // no row → not an admin.
  const row = await db
    .prepare("SELECT provider_user_id FROM identities WHERE user_id = ? AND provider = 'github'")
    .bind(userId)
    .first<{ provider_user_id: string }>();
  return !!row && admins.includes(row.provider_user_id);
}
