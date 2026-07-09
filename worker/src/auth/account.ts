// Account profile endpoints (spec §1 "Profile endpoints"). Handle SETTING
// lives here (it's account profile); handle DISCOVERY is Phase 2 social/.
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { badRequest, conflict, notFound, tooMany } from "../lib/errors";
import { checkRateLimit } from "../lib/rate-limit";
// Route body parsing through the shared helper so malformed JSON becomes a 400
// (not an app.onError 500). See lib/parse-json.ts (knowledge-debt #1).
import { parseJsonBody } from "../lib/parse-json";
import { requireAuth } from "./middleware";
import { HANDLE_COOLDOWN_SEC } from "../maintenance";

// spec §2: 3–30 chars of a-z 0-9 hyphen, starting alphanumeric.
const HANDLE_RE = /^[a-z0-9][a-z0-9-]{2,29}$/;
const RESERVED_HANDLES = new Set([
  "youcoded", "wecoded", "admin", "administrator", "support", "help",
  // "itsdestin" was removed 2026-07-08 so Destin can claim his own handle — the
  // reserve-to-prevent-impersonation idea blocked the real owner too (the Worker
  // can't know who the "real" claimant is). "destin" stays reserved.
  "mod", "moderator", "official", "staff", "system", "root", "destin",
]);

export const accountRoutes = new Hono<HonoEnv>();

// Atomic handle-claim batch (knowledge-debt #2). Exported so the race-guard
// semantics are testable BELOW the route's friendly pre-check: in any
// single-threaded route test a blocking cooldown row 409s at the pre-check
// (identical condition) before this batch ever runs, so only a direct
// batch-level test can pin the no-wrongful-release guarantee.
//
// Statement order (index 0 is load-bearing — the route reads results[0]):
//   [0] conditional UPDATE users — the claim; `NOT EXISTS` re-runs the
//       cooldown-by-others test at write time so a check→claim sniper gets
//       changes === 0 instead of the handle.
//   [1] (only when currentHandle) conditional release-insert stamping
//       released_by = me. WHY it's ALSO conditional: an unconditional release
//       would fire even when the claim UPDATE fails (the race case), wrongly
//       cooling the user's CURRENT handle while they keep it. Gating on the
//       SAME NOT EXISTS means nothing mutates when the claim fails.
//   [2] consume this user's OWN release row for the claimed handle. On a
//       self-reclaim the previous owner's `released_by = me` row must go, or a
//       later rename would leave a stale row with the OLD released_at. The
//       `released_by = me` filter makes it safe on a FAILED claim by a
//       DIFFERENT user: the surviving row is released_by someone-else/NULL, so
//       this matches nothing and the cooldown stays intact.
//
// NUMBERED placeholders (?1/?2/?3…): each is bound ONCE in order, even though
// ?1/?2 are referenced multiple times — same convention as social/routes.ts.
// Don't mix positional ? into these statements or add binds without
// renumbering. Self-reclaim exception (Destin, 2026-07-08): the cooldown test
// excludes rows released_by ME, so the previous owner reclaims immediately;
// `released_by IS NULL` (deleted accounts, FK ON DELETE SET NULL) stays locked
// for everyone.
export function buildHandleClaimBatch(
  db: D1Database,
  args: { handle: string; userId: string; currentHandle: string | null; now: number },
): D1PreparedStatement[] {
  const { handle, userId, currentHandle, now } = args;
  const notExistsCooldown =
    "NOT EXISTS (SELECT 1 FROM handle_releases WHERE handle = ?1 AND released_at >= ?3 AND (released_by IS NULL OR released_by != ?2))";
  const stmts = [
    db
      .prepare(`UPDATE users SET handle = ?1 WHERE id = ?2 AND ${notExistsCooldown}`)
      .bind(handle, userId, now - HANDLE_COOLDOWN_SEC),
  ];
  if (currentHandle) {
    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO handle_releases (handle, released_at, released_by)
           SELECT ?4, ?5, ?2 WHERE ${notExistsCooldown}`,
        )
        .bind(handle, userId, now - HANDLE_COOLDOWN_SEC, currentHandle, now),
    );
  }
  stmts.push(
    db
      .prepare("DELETE FROM handle_releases WHERE handle = ? AND released_by = ?")
      .bind(handle, userId),
  );
  return stmts;
}

accountRoutes.patch("/auth/profile", requireAuth, async (c) => {
  const body = await parseJsonBody<{ display_name?: string }>(c);
  const name = body.display_name?.trim();
  if (!name || name.length > 60) throw badRequest("display_name must be 1-60 characters");
  await c.env.DB.prepare("UPDATE users SET display_name = ? WHERE id = ?")
    .bind(name, c.get("userId")).run();
  return c.json({ display_name: name });
});

accountRoutes.put("/auth/handle", requireAuth, async (c) => {
  const body = await parseJsonBody<{ handle?: string }>(c);
  const handle = body.handle?.trim().toLowerCase();
  if (!handle || !HANDLE_RE.test(handle)) throw badRequest("handle must be 3-30 chars: a-z 0-9 -");
  if (RESERVED_HANDLES.has(handle)) throw badRequest("that handle is reserved");
  const userId = c.get("userId");
  const now = Math.floor(Date.now() / 1000);

  // The no-op check runs BEFORE the cooldown query: a user re-PUTting the
  // handle they already own must always 200, even if a spurious/stale
  // handle_releases row for that handle exists (it would otherwise 409 them
  // out of their own name).
  const current = await c.env.DB.prepare("SELECT handle FROM users WHERE id = ?")
    .bind(userId).first<{ handle: string | null }>();
  if (!current) throw notFound("unknown user");
  if (current.handle === handle) return c.json({ handle }); // no-op rename

  // Cooldown check (anti-sniping, spec §2): a freed handle stays locked 30 days.
  // Self-reclaim exception (Destin, 2026-07-08): the cooldown applies to OTHER
  // users only — the previous owner (released_by = me) can take their old handle
  // back immediately, so a rename never locks you out of your own name. The
  // `released_by IS NULL` half keeps deleted-account releases (FK ON DELETE SET
  // NULL → NULL) locked for everyone. This is only a friendly early 409; the
  // atomic claim below is the real guard.
  const cooling = await c.env.DB
    .prepare("SELECT 1 AS one FROM handle_releases WHERE handle = ? AND released_at >= ? AND (released_by IS NULL OR released_by != ?)")
    .bind(handle, now - HANDLE_COOLDOWN_SEC, userId).first();
  if (cooling) throw conflict("that handle was recently released and is in cooldown");

  // Atomic claim (knowledge-debt #2): the friendly pre-check and the claim have
  // a check→claim gap a sniper could exploit by inserting a cooldown row in
  // between. buildHandleClaimBatch (above) builds the conditional claim — see
  // its comment for the guard semantics and statement order. D1 `batch()` runs
  // the array as one implicit transaction and is the SOLE rename path. The
  // UNIQUE→409 "taken" path is preserved: an actively-owned handle has no
  // cooldown row, so NOT EXISTS passes, the UPDATE attempts the write, and the
  // users.handle UNIQUE index rejects it → batch throws → caught below.
  const stmts = buildHandleClaimBatch(c.env.DB, {
    handle,
    userId,
    currentHandle: current.handle,
    now,
  });
  let results;
  try {
    results = await c.env.DB.batch(stmts);
  } catch (e) {
    // Unique index violation → taken. D1 surfaces it as a generic error;
    // match on message to keep other failures loud.
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE/i.test(msg)) throw conflict("that handle is taken");
    throw e;
  }
  // The conditional UPDATE is stmts[0]. changes === 0 means the NOT EXISTS guard
  // blocked the claim (a cooldown row for this handle, released by someone else,
  // was present at write time) — 409 the same as the friendly pre-check.
  if ((results[0]?.meta.changes ?? 0) === 0) {
    throw conflict("that handle was recently released and is in cooldown");
  }
  return c.json({ handle });
});

// Hard delete (spec §5): the FK ON DELETE CASCADE design removes identities,
// sessions, installs, ratings, theme likes, reports-as-reporter — everything.
// No soft delete for users; status/deleted_at are tier-C *suspension* stubs.
// Observed behavior: D1's FK ON DELETE CASCADE IS active in this toolchain —
// the single `DELETE FROM users` empties identities/sessions/installs/ratings/
// theme_likes (test asserts count=0 for all). No explicit child-delete fallback
// needed. The handle release + user delete run as one DB.batch (implicit
// transaction): INSERT..SELECT reads the handle inside the same transaction
// that deletes the row, so there's no read round-trip and no window where a
// concurrent rename between a separate read and the DELETE loses cooldown.
// Deliberate trade-off: after deletion the old handle is cooldown-locked 30
// days for EVERYONE — including the departed user if they re-register. No
// owner exemption is possible (the identity row is gone); spec §2 anti-sniping.
accountRoutes.delete("/auth/account", requireAuth, async (c) => {
  const userId = c.get("userId");
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT OR REPLACE INTO handle_releases (handle, released_at) SELECT handle, ? FROM users WHERE id = ? AND handle IS NOT NULL"
    ).bind(now, userId),
    c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);
  return c.body(null, 204);
});

// Data export (spec §5): one JSON of every row referencing the account that
// the OWNER is allowed to see. Deliberate exclusions:
//   - rows where this user is the BLOCKED party (blocks WHERE blocked = me) —
//     that would reveal WHO blocked them, defeating the block's one-way secrecy.
//   - session token hashes — only created_at/last_used_at timestamps leave here.
//   - handle_releases — internal cooldown bookkeeping, not owner-facing (the
//     released_by linkage isn't user data either).
accountRoutes.get("/auth/export", requireAuth, async (c) => {
  const userId = c.get("userId");
  if (!(await checkRateLimit(`export:${userId}`, 5, 3600))) throw tooMany("too many export requests");
  const db = c.env.DB;
  const all = <T>(r: { results?: T[] }) => r.results ?? [];
  const [account, identities, sessions, installs, ratings, themeLikes, reports, friendships, requestsIn, requestsOut, blocks] = await Promise.all([
    db.prepare("SELECT id, display_name, avatar_url, handle, status, created_at, last_seen_at FROM users WHERE id = ?").bind(userId).first(),
    db.prepare("SELECT provider, provider_user_id, provider_login, linked_at FROM identities WHERE user_id = ?").bind(userId).all(),
    // Timestamps only — never token_hash. See exclusion note above.
    db.prepare("SELECT created_at, last_used_at FROM sessions WHERE user_id = ?").bind(userId).all(),
    // Every export query pins its column list — never SELECT * here. A future
    // migration adding a column to these tables must OPT IN to the export by
    // editing this endpoint, not leak silently through a wildcard.
    db.prepare("SELECT user_id, plugin_id, installed_at FROM installs WHERE user_id = ?").bind(userId).all(),
    db.prepare("SELECT user_id, plugin_id, stars, review_text, created_at, updated_at, hidden FROM ratings WHERE user_id = ?").bind(userId).all(),
    db.prepare("SELECT user_id, theme_id, liked_at FROM theme_likes WHERE user_id = ?").bind(userId).all(),
    // rating_user_id identifies the review the owner CHOSE to report — the one
    // deliberate non-owner id in the export (an opaque account id the owner
    // already acted on; reveals nothing about blocks or private state).
    db.prepare("SELECT id, rating_user_id, rating_plugin_id, reporter_user_id, reason, created_at, resolved_at, resolution FROM reports WHERE reporter_user_id = ?").bind(userId).all(),
    db.prepare("SELECT user_low, user_high, created_at FROM friendships WHERE user_low = ? OR user_high = ?").bind(userId, userId).all(),
    db.prepare("SELECT id, from_user, created_at FROM friend_requests WHERE to_user = ?").bind(userId).all(),
    db.prepare("SELECT id, to_user, created_at FROM friend_requests WHERE from_user = ?").bind(userId).all(),
    // Only blocks the user MADE (blocker = me) — never blocks AGAINST them.
    db.prepare("SELECT blocked, created_at FROM blocks WHERE blocker = ?").bind(userId).all(),
  ]);
  return c.json({
    exported_at: Math.floor(Date.now() / 1000),
    account,
    identities: all(identities),
    sessions: all(sessions),
    installs: all(installs),
    ratings: all(ratings),
    theme_likes: all(themeLikes),
    reports: all(reports),
    friendships: all(friendships),
    friend_requests: { incoming: all(requestsIn), outgoing: all(requestsOut) },
    blocks: all(blocks),
  });
});
