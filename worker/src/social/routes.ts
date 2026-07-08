// Walled social module (spec §2): talks to identity ONLY through requireAuth
// and user ids. Every route is session-gated — there is deliberately no
// unauthenticated handle-probing surface.
import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { requireAuth } from "../auth/middleware";
import { notFound, tooMany } from "../lib/errors";
import { checkRateLimit } from "../lib/rate-limit";
import { isBlockedEitherWay } from "./graph";
import type { UserCard } from "./graph";

export const socialRoutes = new Hono<HonoEnv>();

// Exact-match handle lookup → one minimal card. Prefix/fuzzy search is
// deliberately excluded (user-enumeration surface — spec §2).
socialRoutes.get("/social/users/:handle", requireAuth, async (c) => {
  const me = c.get("userId");
  if (!(await checkRateLimit(`social-lookup:${me}`, 30, 3600))) {
    throw tooMany("too many lookups");
  }
  const handle = c.req.param("handle").toLowerCase();
  const card = await c.env.DB
    .prepare("SELECT id, display_name, handle, avatar_url FROM users WHERE handle = ?")
    .bind(handle).first<UserCard>();
  // A blocked pair looks exactly like a missing handle — no probing oracle.
  if (!card || (await isBlockedEitherWay(c.env.DB, me, card.id))) {
    throw notFound("no user with that handle");
  }
  return c.json(card);
});
