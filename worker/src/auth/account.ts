// Account profile endpoints (spec §1 "Profile endpoints"). Handle SETTING
// lives here (it's account profile); handle DISCOVERY is Phase 2 social/.
import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { badRequest, conflict, notFound } from "../lib/errors";
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
  const cooling = await c.env.DB
    .prepare("SELECT 1 AS one FROM handle_releases WHERE handle = ? AND released_at >= ?")
    .bind(handle, now - HANDLE_COOLDOWN_SEC).first();
  if (cooling) throw conflict("that handle was recently released and is in cooldown");

  // Atomicity fix (Task 4 quality review): the rename UPDATE and the
  // handle_releases INSERT must land together. Two separate statements meant a
  // crash between them would leave the old handle un-cooled (sniping window).
  // D1 `batch()` runs the array as one implicit transaction and is the SOLE
  // rename path. The UNIQUE→409 path is preserved: batch() rejects with the
  // failing statement's error, so a collision still throws an Error whose
  // message contains "UNIQUE" (verified empirically — the taken-handle test
  // 409s through this catch). Conditional shape: when there's an old handle to
  // release we batch both statements; otherwise just the rename.
  const stmts = [
    c.env.DB.prepare("UPDATE users SET handle = ? WHERE id = ?").bind(handle, userId),
  ];
  if (current.handle) {
    stmts.push(
      c.env.DB
        .prepare("INSERT OR REPLACE INTO handle_releases (handle, released_at) VALUES (?, ?)")
        .bind(current.handle, now),
    );
  }
  try {
    await c.env.DB.batch(stmts);
  } catch (e) {
    // Unique index violation → taken. D1 surfaces it as a generic error;
    // match on message to keep other failures loud.
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE/i.test(msg)) throw conflict("that handle is taken");
    throw e;
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
