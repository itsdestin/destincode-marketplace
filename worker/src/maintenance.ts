// Daily hygiene (spec §5): one job prunes everything with a TTL. Pure function
// of (db, now) so tests don't depend on SELF.scheduled() plumbing.
import type { D1Database } from "@cloudflare/workers-types";
import { SESSION_MAX_IDLE_SEC } from "./auth/sessions";

export const HANDLE_COOLDOWN_SEC = 30 * 24 * 3600; // spec §2: 30-day handle cooldown

export async function pruneExpired(db: D1Database, now: number): Promise<void> {
  // Strict `<` here is INTENTIONALLY identical to resolveSession's expiry check
  // (sessions.ts): both compare last_used_at against `now - SESSION_MAX_IDLE_SEC`
  // strictly, so the cron never deletes a row resolveSession would still accept.
  await db.prepare("DELETE FROM sessions WHERE last_used_at < ?").bind(now - SESSION_MAX_IDLE_SEC).run();
  await db.prepare("DELETE FROM handle_releases WHERE released_at < ?").bind(now - HANDLE_COOLDOWN_SEC).run();
  await db.prepare("DELETE FROM device_codes WHERE expires_at < ?").bind(now).run();
}
