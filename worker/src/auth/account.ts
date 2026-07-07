// Account profile endpoints (spec §1 "Profile endpoints"). Handle SETTING
// lives here (it's account profile); handle DISCOVERY is Phase 2 social/.
import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { badRequest, notFound } from "../lib/errors";
import { HTTPException } from "hono/http-exception";
import { requireAuth } from "./middleware";
import { HANDLE_COOLDOWN_SEC } from "../maintenance";

// spec §2: 3–30 chars of a-z 0-9 hyphen, starting alphanumeric.
const HANDLE_RE = /^[a-z0-9][a-z0-9-]{2,29}$/;
const RESERVED_HANDLES = new Set([
  "youcoded", "wecoded", "admin", "administrator", "support", "help",
  "mod", "moderator", "official", "staff", "system", "root", "destin", "itsdestin",
]);

// No `conflict` helper exists in lib/errors.ts (only 400/401/403/404/429), so
// define a local 409 for the two handle-collision paths (taken + cooldown).
function conflict(message: string): HTTPException {
  return new HTTPException(409, { message });
}

export const accountRoutes = new Hono<HonoEnv>();

accountRoutes.patch("/auth/profile", requireAuth, async (c) => {
  const body = await c.req.json<{ display_name?: string }>();
  const name = body.display_name?.trim();
  if (!name || name.length > 60) throw badRequest("display_name must be 1-60 characters");
  await c.env.DB.prepare("UPDATE users SET display_name = ? WHERE id = ?")
    .bind(name, c.get("userId")).run();
  return c.json({ display_name: name });
});

accountRoutes.put("/auth/handle", requireAuth, async (c) => {
  const body = await c.req.json<{ handle?: string }>();
  const handle = body.handle?.trim().toLowerCase();
  if (!handle || !HANDLE_RE.test(handle)) throw badRequest("handle must be 3-30 chars: a-z 0-9 -");
  if (RESERVED_HANDLES.has(handle)) throw badRequest("that handle is reserved");
  const userId = c.get("userId");
  const now = Math.floor(Date.now() / 1000);

  // Cooldown check (anti-sniping, spec §2): a freed handle stays locked 30 days.
  const cooling = await c.env.DB
    .prepare("SELECT 1 AS one FROM handle_releases WHERE handle = ? AND released_at >= ?")
    .bind(handle, now - HANDLE_COOLDOWN_SEC).first();
  if (cooling) throw conflict("that handle was recently released and is in cooldown");

  const current = await c.env.DB.prepare("SELECT handle FROM users WHERE id = ?")
    .bind(userId).first<{ handle: string | null }>();
  if (!current) throw notFound("unknown user");
  if (current.handle === handle) return c.json({ handle }); // no-op rename

  try {
    await c.env.DB.prepare("UPDATE users SET handle = ? WHERE id = ?").bind(handle, userId).run();
  } catch (e) {
    // Unique index violation → taken. D1 surfaces it as a generic error;
    // match on message to keep other failures loud.
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE/i.test(msg)) throw conflict("that handle is taken");
    throw e;
  }

  // Release the previous handle into cooldown AFTER the rename succeeds.
  if (current.handle) {
    await c.env.DB
      .prepare("INSERT OR REPLACE INTO handle_releases (handle, released_at) VALUES (?, ?)")
      .bind(current.handle, now).run();
  }
  return c.json({ handle });
});
