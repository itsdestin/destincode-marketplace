// Admin allowlist, keyed on the GitHub identity (numeric id) via `identities`
// — NOT on account ids, so it survives id-format changes (spec §1).
// ADMIN_USER_IDS: comma-separated GitHub numeric ids.
import type { D1Database } from "@cloudflare/workers-types";
import type { Context } from "hono";
import type { HonoEnv } from "../types";
import { forbidden } from "../lib/errors";

export async function isAdminAccount(
  db: D1Database,
  env: { ADMIN_USER_IDS: string },
  userId: string
): Promise<boolean> {
  // ?? "" — a missing secret (fresh env, skipped CI secret-push) should deny
  // cleanly as 403, not crash into a 500. Fail closed either way.
  const admins = (env.ADMIN_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
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

// Inline admin gate for a route whose auth middleware (requireAdminAuth) has
// already set `userId`. Throws 403 — authenticated-but-not-admin — which stays
// distinct from the 401 that requireAdminAuth throws for missing/invalid
// credentials. Deliberately a per-route call rather than folded into the
// middleware so that 401/403 split is preserved (see admin-middleware.ts); this
// only DRYs the identical isAdminAccount check that 9 routes copy-pasted.
export async function requireAdminAccount(c: Context<HonoEnv>): Promise<void> {
  if (!(await isAdminAccount(c.env.DB, c.env, c.get("userId")))) throw forbidden("admin only");
}
