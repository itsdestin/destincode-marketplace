// Walled social module (spec §2): talks to identity ONLY through requireAuth
// and user ids. Every route is session-gated — there is deliberately no
// unauthenticated handle-probing surface.
import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { requireAuth } from "../auth/middleware";
import { badRequest, notFound, tooMany } from "../lib/errors";
import { parseJsonBody } from "../lib/parse-json";
import { randomToken } from "../lib/crypto";
import { checkRateLimit } from "../lib/rate-limit";
import { CARD_COLUMNS, areFriends, isBlockedEitherWay, pairKey } from "./graph";
import type { UserCard } from "./graph";

export const socialRoutes = new Hono<HonoEnv>();

// Exact-match handle lookup → one minimal card. Prefix/fuzzy search is
// deliberately excluded (user-enumeration surface — spec §2).
socialRoutes.get("/social/users/:handle", requireAuth, async (c) => {
  const me = c.get("userId");
  if (!(await checkRateLimit(`social-lookup:${me}`, 30, 3600))) {
    throw tooMany("too many lookups");
  }
  const handle = c.req.param("handle").trim().toLowerCase();
  const card = await c.env.DB
    .prepare(`SELECT ${CARD_COLUMNS} FROM users WHERE handle = ?`)
    .bind(handle).first<UserCard>();
  // A blocked pair looks exactly like a missing handle — no probing oracle.
  if (!card || (await isBlockedEitherWay(c.env.DB, me, card.id))) {
    throw notFound("no user with that handle");
  }
  return c.json(card);
});

const DAILY_REQUEST_CAP = 20; // spec §2: per-user daily cap, D1-count authoritative

socialRoutes.post("/social/requests", requireAuth, async (c) => {
  const me = c.get("userId");
  if (!(await checkRateLimit(`social-request:${me}`, 30, 3600))) throw tooMany("too many friend requests");
  const body = await parseJsonBody<{ handle?: string }>(c);
  const handle = body.handle?.trim().toLowerCase();
  if (!handle) throw badRequest("handle is required");

  const target = await c.env.DB
    .prepare("SELECT id FROM users WHERE handle = ?").bind(handle).first<{ id: string }>();
  // Blocked pairs are indistinguishable from missing handles — same as lookup.
  if (!target || (await isBlockedEitherWay(c.env.DB, me, target.id))) throw notFound("no user with that handle");
  if (target.id === me) throw badRequest("that's you");
  if (await areFriends(c.env.DB, me, target.id)) return c.json({ status: "friends" });

  const now = Math.floor(Date.now() / 1000);

  // Mutual intent: their pending request to me == acceptance (spec §2).
  const inverse = await c.env.DB
    .prepare("SELECT id FROM friend_requests WHERE from_user = ? AND to_user = ?")
    .bind(target.id, me).first<{ id: string }>();
  if (inverse) {
    const [low, high] = pairKey(me, target.id);
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT OR IGNORE INTO friendships (user_low, user_high, created_at) VALUES (?, ?, ?)").bind(low, high, now),
      c.env.DB.prepare("DELETE FROM friend_requests WHERE id = ?").bind(inverse.id),
      // Also clear MY direction: after a concurrent mutual-send race both rows
      // can exist, and deleting only the inverse would strand mine as a
      // phantom pending request on an already-friends pair.
      c.env.DB.prepare("DELETE FROM friend_requests WHERE from_user = ? AND to_user = ?").bind(me, target.id),
    ]);
    // Task 7 adds a presence poke here
    return c.json({ status: "friends" });
  }

  const dup = await c.env.DB
    .prepare("SELECT id FROM friend_requests WHERE from_user = ? AND to_user = ?")
    .bind(me, target.id).first<{ id: string }>();
  if (dup) return c.json({ status: "pending" });

  // Daily cap on pending-request creation. Resolved requests vanish from this
  // count — accepted looseness at current scale (spec §2: "simple D1 counts").
  const sentToday = await c.env.DB
    .prepare("SELECT COUNT(*) AS n FROM friend_requests WHERE from_user = ? AND created_at > ?")
    .bind(me, now - 86400).first<{ n: number }>();
  if ((sentToday?.n ?? 0) >= DAILY_REQUEST_CAP) throw tooMany("daily friend-request limit reached");

  // OR IGNORE: concurrent identical sends must be idempotent, not a 500 — the
  // only realistic conflict is the UNIQUE(from_user, to_user) race (both FK
  // parents were validated above), and "pending" is then the true answer.
  await c.env.DB
    .prepare("INSERT OR IGNORE INTO friend_requests (id, from_user, to_user, created_at) VALUES (?, ?, ?, ?)")
    .bind("freq_" + randomToken(16), me, target.id, now).run();
  return c.json({ status: "pending" });
});

socialRoutes.get("/social/requests", requireAuth, async (c) => {
  const me = c.get("userId");
  // The aliased list below is CARD_COLUMNS with u.id renamed to uid (the bare
  // r.id is the request id) — keep in sync with CARD_COLUMNS in ./graph.
  const incoming = await c.env.DB.prepare(
    `SELECT r.id, r.created_at, u.id AS uid, u.display_name, u.handle, u.avatar_url
     FROM friend_requests r JOIN users u ON u.id = r.from_user
     WHERE r.to_user = ? ORDER BY r.created_at DESC`
  ).bind(me).all<{ id: string; created_at: number; uid: string; display_name: string; handle: string | null; avatar_url: string | null }>();
  const outgoing = await c.env.DB.prepare(
    `SELECT r.id, r.created_at, u.id AS uid, u.display_name, u.handle, u.avatar_url
     FROM friend_requests r JOIN users u ON u.id = r.to_user
     WHERE r.from_user = ? ORDER BY r.created_at DESC`
  ).bind(me).all<{ id: string; created_at: number; uid: string; display_name: string; handle: string | null; avatar_url: string | null }>();
  const card = (r: { uid: string; display_name: string; handle: string | null; avatar_url: string | null }): UserCard =>
    ({ id: r.uid, display_name: r.display_name, handle: r.handle, avatar_url: r.avatar_url });
  return c.json({
    incoming: (incoming.results ?? []).map((r) => ({ id: r.id, from: card(r), created_at: r.created_at })),
    outgoing: (outgoing.results ?? []).map((r) => ({ id: r.id, to: card(r), created_at: r.created_at })),
  });
});

socialRoutes.post("/social/requests/:id/accept", requireAuth, async (c) => {
  const me = c.get("userId");
  // Recipient only: the id+to_user filter makes someone else's request 404,
  // indistinguishable from a nonexistent one.
  const req = await c.env.DB
    .prepare("SELECT id, from_user, to_user FROM friend_requests WHERE id = ? AND to_user = ?")
    .bind(c.req.param("id"), me).first<{ id: string; from_user: string; to_user: string }>();
  if (!req) throw notFound("no such request");
  const now = Math.floor(Date.now() / 1000);
  const [low, high] = pairKey(req.from_user, req.to_user);
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT OR IGNORE INTO friendships (user_low, user_high, created_at) VALUES (?, ?, ?)").bind(low, high, now),
    c.env.DB.prepare("DELETE FROM friend_requests WHERE id = ?").bind(req.id),
    // Clear any inverse pending row so the pair is fully settled.
    c.env.DB.prepare("DELETE FROM friend_requests WHERE from_user = ? AND to_user = ?").bind(req.to_user, req.from_user),
  ]);
  // Task 7 adds a presence poke here
  return c.json({ ok: true });
});

socialRoutes.post("/social/requests/:id/decline", requireAuth, async (c) => {
  const me = c.get("userId");
  const res = await c.env.DB
    .prepare("DELETE FROM friend_requests WHERE id = ? AND to_user = ?")
    .bind(c.req.param("id"), me).run();
  if (res.meta.changes === 0) throw notFound("no such request");
  return c.json({ ok: true }); // silent — sender is never notified (spec §2)
});

socialRoutes.delete("/social/requests/:id", requireAuth, async (c) => {
  const me = c.get("userId");
  const res = await c.env.DB
    .prepare("DELETE FROM friend_requests WHERE id = ? AND from_user = ?")
    .bind(c.req.param("id"), me).run();
  if (res.meta.changes === 0) throw notFound("no such request");
  return c.json({ ok: true });
});

// Friends-list row: user card + last_seen_at + friends-since. This shape is
// the client contract (mergeFriends in the youcoded renderer) — keep exact.
interface FriendRow extends UserCard {
  last_seen_at: number | null;
  created_at: number; // friends-since (the friendship row's timestamp, NOT account age)
}

socialRoutes.get("/social/friends", requireAuth, async (c) => {
  const me = c.get("userId");
  // Both directions of the canonical pair, joined to cards + last_seen_at
  // (the ONLY persisted presence fact — spec §5). The CASE picks the OTHER
  // side of the pair regardless of whether `me` is user_low or user_high.
  // NOTE: ?1 is a NUMBERED placeholder — one bound value (me) reused 3x. The
  // rest of this file uses positional ? — don't mix styles within one query,
  // and don't copy this query and add a second bind without renumbering.
  const rows = await c.env.DB.prepare(
    `SELECT u.id, u.display_name, u.handle, u.avatar_url, u.last_seen_at, f.created_at
     FROM friendships f
     JOIN users u ON u.id = CASE WHEN f.user_low = ?1 THEN f.user_high ELSE f.user_low END
     WHERE f.user_low = ?1 OR f.user_high = ?1
     ORDER BY u.display_name COLLATE NOCASE`
  ).bind(me).all<FriendRow>();
  return c.json(rows.results ?? []);
});

socialRoutes.delete("/social/friends/:userId", requireAuth, async (c) => {
  const me = c.get("userId");
  const other = c.req.param("userId");
  const [low, high] = pairKey(me, other);
  const res = await c.env.DB
    .prepare("DELETE FROM friendships WHERE user_low = ? AND user_high = ?")
    .bind(low, high).run();
  if (res.meta.changes === 0) throw notFound("not friends");
  // Task 7 adds a presence poke here — unfriending changes presence visibility,
  // so the ex-friend must be told to drop this user from their roster.
  return c.json({ ok: true }); // silent — the ex-friend is never notified (spec §2)
});
