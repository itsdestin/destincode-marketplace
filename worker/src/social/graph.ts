// Friend-graph primitives shared by routes and (later) the PresenceRoom DO.
// All helpers take D1Database explicitly (same convention as src/db.ts).
import type { D1Database } from "@cloudflare/workers-types";

export interface UserCard {
  id: string;
  display_name: string;
  handle: string | null;
  avatar_url: string | null;
}

// The "minimal card" column list — the ONLY user columns social code may
// select. Shared so the shape can't drift between the by-id and by-handle
// lookups (and the request/friend/block card queries in later routes).
export const CARD_COLUMNS = "id, display_name, handle, avatar_url";

/** Canonical (user_low, user_high) ordering for the friendships table. */
export function pairKey(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export async function areFriends(db: D1Database, a: string, b: string): Promise<boolean> {
  const [low, high] = pairKey(a, b);
  const row = await db
    .prepare("SELECT 1 AS one FROM friendships WHERE user_low = ? AND user_high = ?")
    .bind(low, high).first();
  return row !== null;
}

/** Block beats friend everywhere — most checks care about either direction. */
export async function isBlockedEitherWay(db: D1Database, a: string, b: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS one FROM blocks WHERE (blocker = ? AND blocked = ?) OR (blocker = ? AND blocked = ?)")
    .bind(a, b, b, a).first();
  return row !== null;
}

export async function loadFriendIds(db: D1Database, userId: string): Promise<string[]> {
  const rows = await db
    .prepare("SELECT user_high AS fid FROM friendships WHERE user_low = ? UNION ALL SELECT user_low AS fid FROM friendships WHERE user_high = ?")
    .bind(userId, userId).all<{ fid: string }>();
  return (rows.results ?? []).map((r) => r.fid);
}

export async function getUserCard(db: D1Database, userId: string): Promise<UserCard | null> {
  return db
    .prepare(`SELECT ${CARD_COLUMNS} FROM users WHERE id = ?`)
    .bind(userId).first<UserCard>();
}
