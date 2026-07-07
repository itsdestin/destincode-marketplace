// Session issuance/resolution/revocation. Raw bearer token is handed back to
// the caller of issueSession; only the hash is persisted in `sessions`.

import type { D1Database } from "@cloudflare/workers-types";
import { randomToken, sha256Hex } from "../lib/crypto";

// Sessions idle longer than this are invalid (and pruned by the daily cron).
export const SESSION_MAX_IDLE_SEC = 90 * 24 * 3600;

export async function issueSession(db: D1Database, userId: string): Promise<string> {
  const token = randomToken(32);
  const hash = await sha256Hex(token);
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare("INSERT INTO sessions (token_hash, user_id, created_at, last_used_at) VALUES (?, ?, ?, ?)")
    .bind(hash, userId, now, now)
    .run();
  return token;
}

export async function resolveSession(db: D1Database, token: string): Promise<string | null> {
  const hash = await sha256Hex(token);
  const row = await db
    .prepare("SELECT user_id, last_used_at FROM sessions WHERE token_hash = ?")
    .bind(hash)
    .first<{ user_id: string; last_used_at: number }>();
  if (!row) return null;
  const now = Math.floor(Date.now() / 1000);
  // Enforce idle expiry: a session untouched for longer than the idle window is
  // dead. Delete it eagerly so the row doesn't linger until the cron prune.
  if (row.last_used_at < now - SESSION_MAX_IDLE_SEC) {
    await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(hash).run();
    return null;
  }
  await db
    .prepare("UPDATE sessions SET last_used_at = ? WHERE token_hash = ?")
    .bind(now, hash)
    .run();
  return row.user_id;
}

export async function revokeSession(db: D1Database, token: string): Promise<void> {
  const hash = await sha256Hex(token);
  await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(hash).run();
}
