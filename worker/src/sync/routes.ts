// SyncHub connect route (spec §6). Auth happens HERE, in the worker route —
// the DO only trusts the internal X-Sync-* headers this route sets. Mirrors
// social/routes.ts's presence upgrade exactly.
import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { requireAuth } from "../auth/middleware";
import { badRequest } from "../lib/errors";

export const syncRoutes = new Hono<HonoEnv>();

// Authenticated WebSocket upgrade → forward to this account's SyncGroupRoom.
// No ?device= trust for identity — the account id comes from the session token
// (requireAuth); ?device= is only a human label carried through for logging.
syncRoutes.get("/sync/hub", requireAuth, async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    throw badRequest("expected a websocket upgrade");
  }
  const userId = c.get("userId");
  // One room per account — the sync group IS the user's own device set.
  const stub = c.env.SYNC_HUB.get(c.env.SYNC_HUB.idFromName(userId));
  const fwd = new Request("https://synchub.internal/connect", c.req.raw);
  fwd.headers.set("X-Sync-User", userId);
  fwd.headers.set("X-Sync-Device", c.req.query("device") ?? "unknown");
  return stub.fetch(fwd);
});
