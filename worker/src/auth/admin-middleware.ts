// Dual-auth middleware for admin routes.
// - Authorization: Bearer <session-token> → existing cookie-flow path (D1 sessions table).
// - X-GitHub-PAT: <pat>                  → admin CLI skill path (PAT → GitHub /user).
//
// Sets userId (the platform account id) on the Hono context either way. The
// admin allowlist check stays inline in each route via isAdminAccount(db, env,
// userId) so 401 (not authenticated) and 403 (authenticated but not an admin)
// remain distinguishable.
import type { MiddlewareHandler } from "hono";
import type { HonoEnv } from "../types";
import { unauthorized } from "../lib/errors";
import { resolveSession } from "./sessions";
import { resolvePat } from "./pat";

export const requireAdminAuth: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const userId = await resolveSession(c.env.DB, token);
    if (!userId) throw unauthorized("invalid token");
    c.set("userId", userId);
    return next();
  }

  const pat = c.req.header("X-GitHub-PAT");
  if (pat) {
    // resolvePat maps the PAT's GitHub identity to a platform account via the DB.
    const userId = await resolvePat(c.env.DB, pat);
    if (!userId) throw unauthorized("invalid pat");
    c.set("userId", userId);
    return next();
  }

  throw unauthorized();
};
