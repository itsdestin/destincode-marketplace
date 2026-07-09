// Daily hygiene (spec §5): one job prunes everything with a TTL. Pure function
// of (db, now) so tests don't depend on SELF.scheduled() plumbing.
import type { D1Database } from "@cloudflare/workers-types";
import { SESSION_MAX_IDLE_SEC } from "./auth/sessions";

export const HANDLE_COOLDOWN_SEC = 30 * 24 * 3600; // spec §2: 30-day handle cooldown
export const FRIEND_REQUEST_MAX_AGE_SEC = 90 * 24 * 3600; // spec §5 cron hygiene

export async function pruneExpired(db: D1Database, now: number): Promise<void> {
  // One batch (implicit transaction): a partial failure can't strand later
  // deletes until tomorrow's run — previously three sequential .run()s meant a
  // throw on statement N skipped N+1..end for a full day (knowledge-debt #3).
  // Strict `<` on sessions is INTENTIONALLY identical to resolveSession's expiry
  // check (sessions.ts): both compare last_used_at against `now -
  // SESSION_MAX_IDLE_SEC` strictly, so the cron never deletes a row
  // resolveSession would still accept.
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE last_used_at < ?").bind(now - SESSION_MAX_IDLE_SEC),
    db.prepare("DELETE FROM handle_releases WHERE released_at < ?").bind(now - HANDLE_COOLDOWN_SEC),
    db.prepare("DELETE FROM device_codes WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM friend_requests WHERE created_at < ?").bind(now - FRIEND_REQUEST_MAX_AGE_SEC),
  ]);
}
