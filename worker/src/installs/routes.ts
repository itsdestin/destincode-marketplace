import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { requireAuth } from "../auth/middleware";
import { badRequest, tooMany } from "../lib/errors";
import { validateId, requireCatalogId, filterCatalogIds } from "../lib/validate";
import { checkRateLimit } from "../lib/rate-limit";
import { parseJsonBody } from "../lib/parse-json";

export const installRoutes = new Hono<HonoEnv>();

/** Ceiling on one reconcile call. A real profile holds a few dozen plugins;
 *  200 is generous headroom while keeping the D1 batch bounded. */
const MAX_INSTALL_BATCH = 200;

// POST /installs — records that an authenticated user installed a plugin.
// Idempotent via UNIQUE(user_id, plugin_id) + ON CONFLICT DO NOTHING so that
// repeated installs from the same user don't error or double-count.
//
// Two body shapes:
//   { plugin_id: "x" }        — one install, the moment it happens
//   { plugin_ids: ["x","y"] } — RECONCILE: everything the client currently has
//
// The batch form exists because this table only ever learned about installs
// made while signed in. Plugins bundled with YouCoded are auto-installed at
// launch through a different code path entirely, and anything installed while
// signed out or on another device was never reported — so `hasInstall` said
// false for plugins the user demonstrably has, and POST /thumbs refused their
// vote with "must install plugin before voting". The client now re-reports its
// full set on sign-in. Sending them one at a time would be N round-trips and N
// rate-limit ticks every time someone signs in.
installRoutes.post("/installs", requireAuth, async (c) => {
  // Rate limit: 100/hour per user is well above normal human behavior but
  // stops scripted install-count inflation. A batch costs ONE tick, not N —
  // otherwise a reconcile would exhaust the budget it is trying to fix.
  const userId = c.get("userId");
  if (!(await checkRateLimit(`installs:${userId}`, 100, 3600))) {
    throw tooMany("too many installs per hour");
  }
  // parseJsonBody, not c.req.json(): malformed input becomes a 400 instead of an
  // unhandled throw that surfaces as a 500. Every other route already does this.
  const body = await parseJsonBody<{ plugin_id?: string; plugin_ids?: unknown }>(c);

  let ids: string[];
  let skipped = 0;
  if (body.plugin_ids !== undefined) {
    if (!Array.isArray(body.plugin_ids) || body.plugin_ids.length === 0) {
      throw badRequest("plugin_ids must be a non-empty array");
    }
    if (body.plugin_ids.length > MAX_INSTALL_BATCH) {
      throw badRequest(`too many plugin_ids (at most ${MAX_INSTALL_BATCH})`);
    }
    // validateId rejects the whole call on any bad entry rather than silently
    // dropping it — a partial reconcile that reports success is how the client
    // would come to believe a plugin was recorded when it was not.
    // Dedupe AFTER validating: `[...new Set()]` on raw input would hide a bad id.
    ids = [...new Set(body.plugin_ids.map((raw) => validateId(raw as string | undefined)))];
    // …then drop anything the catalog does not list. A reconcile reports whatever
    // the client holds, and some of that legitimately is not a marketplace listing
    // (a self-built plugin, one installed from a path). Rejecting the whole call
    // for one of those would record NO installs and leave every vote refused with
    // "must install plugin before voting" — so unknown ids are dropped and the
    // response says how many. A malformed id still rejects the call, above.
    const kept = await filterCatalogIds(c.env.DB, ids);
    skipped = ids.length - kept.length;
    ids = kept;
  } else {
    ids = [await requireCatalogId(c.env.DB, body.plugin_id)];
  }

  const now = Math.floor(Date.now() / 1000);
  // ON CONFLICT DO NOTHING, never DO UPDATE: reconcile runs on every sign-in,
  // and refreshing installed_at would rewrite the install history each time.
  // `ids` can be empty once unknown listings are dropped above, and D1 rejects an
  // empty batch — a reconcile of nothing must be a quiet success, not a 500.
  if (ids.length) await c.env.DB.batch(
    ids.map((id) =>
      c.env.DB
        .prepare(
          `INSERT INTO installs (user_id, plugin_id, installed_at) VALUES (?, ?, ?)
           ON CONFLICT(user_id, plugin_id) DO NOTHING`
        )
        .bind(userId, id, now)
    )
  );
  return body.plugin_ids !== undefined
    // `skipped` appears only when something WAS dropped, so the common response
    // shape is unchanged for every client that already reads `recorded`.
    ? c.json(skipped > 0 ? { ok: true, recorded: ids.length, skipped } : { ok: true, recorded: ids.length })
    : c.json({ ok: true });
});
