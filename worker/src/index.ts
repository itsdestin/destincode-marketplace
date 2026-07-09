import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { cors } from "hono/cors";
import type { Env, HonoEnv } from "./types";
import { authRoutes } from "./auth/routes";
import { accountRoutes } from "./auth/account";
import { installRoutes } from "./installs/routes";
import { ratingRoutes } from "./ratings/routes";
import { themeRoutes } from "./themes/routes";
import { statsRoutes } from "./stats/routes";
import { reportRoutes } from "./reports/routes";
import { appRoutes } from "./app/routes";
import { socialRoutes } from "./social/routes";
import { adminAnalyticsRoutes } from "./admin/analytics";
import { adminDashboardRoute } from "./admin/dashboard-route";
import { pruneExpired } from "./maintenance";

const app = new Hono<HonoEnv>();

// Allowlist of origins permitted to call the worker for AUTHENTICATED routes
// (writes — installs, ratings POST/DELETE, theme likes, reports, admin).
// Keep this tight — these are the only surfaces that should legitimately make
// authenticated calls to the marketplace API.
const ALLOWED_ORIGINS = [
  "https://youcoded.com",
  "app://youcoded",          // Electron packaged app
  "http://localhost:5173",     // desktop dev
  "http://localhost:5223",     // desktop dev (offset via YOUCODED_PORT_OFFSET=50)
  "http://localhost:9901",     // Android LocalBridgeServer
];

// CORS strategy:
//   PUBLIC READ endpoints (GET /stats, GET /ratings/:plugin_id) accept any
//   origin because the data is already public — Android's WebView loads React
//   from `file:///android_asset/web/index.html`, which sends `Origin: null`,
//   and that's not in (and shouldn't be in) the strict allowlist below.
//   Allowing `*` for these specific public-read endpoints fixes the "Couldn't
//   load reviews" error on Android without broadening write-endpoint CORS.
//
//   EVERYTHING ELSE keeps the strict origin allowlist. Writes are gated by
//   `requireAuth` (Bearer token) regardless of CORS, but the allowlist is a
//   defense-in-depth layer that prevents `null`-origin contexts (sandboxed
//   iframes, file:// pages, data: URLs) from even attempting writes.
const publicReadCors = cors({
  origin: "*",
  allowMethods: ["GET"],
  allowHeaders: ["Content-Type"],
  credentials: false,
});

const strictCors = cors({
  origin: (origin) => (ALLOWED_ORIGINS.includes(origin ?? "") ? origin! : null),
  // PATCH/PUT added for the account endpoints (PATCH /auth/profile, PUT
  // /auth/handle) — without them the browser preflight fails and the renderer
  // can't call them under CORS (tests use SELF.fetch, which bypasses CORS).
  allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
  allowHeaders: ["Content-Type", "Authorization"],
  credentials: false,
});

// Path matcher for public-read endpoints. Tight: GET /stats exact, GET
// /ratings/<single-segment plugin_id>. Anything else falls through to strict.
function isPublicReadPath(path: string): boolean {
  if (path === "/stats") return true;
  if (path.startsWith("/ratings/")) {
    const rest = path.slice("/ratings/".length);
    return rest.length > 0 && !rest.includes("/");
  }
  return false;
}

app.use("*", async (c, next) => {
  // For OPTIONS preflight, the browser sets `Access-Control-Request-Method`
  // to the actual upcoming method. Honor that to dispatch correctly — without
  // it, a preflight for `GET /stats` arrives as `OPTIONS /stats` and the
  // method check below would route it to strictCors instead of publicReadCors.
  const requestedMethod = c.req.header("Access-Control-Request-Method") ?? c.req.method;
  if (requestedMethod === "GET" && isPublicReadPath(c.req.path)) {
    return publicReadCors(c, next);
  }
  return strictCors(c, next);
});

// Error handler: HTTPException responses (badRequest, forbidden, tooMany, etc.)
// keep their own status+body. Any other thrown Error becomes JSON 500 instead
// of Hono's default plain-text so admin-skill + dashboard callers can parse the
// message — and so the admin analytics SQL-API errors are debuggable in prod.
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  const message = err instanceof Error ? err.message : "internal error";
  console.error("worker onError:", message);
  return c.json({ ok: false, error: message }, 500);
});

app.get("/health", (c) => c.json({ ok: true }));
app.route("/", authRoutes);
app.route("/", accountRoutes);
app.route("/", installRoutes);
app.route("/", ratingRoutes);
app.route("/", themeRoutes);
app.route("/", statsRoutes);
app.route("/", reportRoutes);
app.route("/", appRoutes);
app.route("/", socialRoutes);
app.route("/", adminAnalyticsRoutes);
app.route("/", adminDashboardRoute);

// Export the fetch handler plus a scheduled() handler for the daily maintenance
// cron. The export shape changes from `app` to `{ fetch, scheduled }`, but
// SELF.fetch (and Cloudflare's runtime) accept either shape, so HTTP routing is
// unchanged. Cron trigger is declared in wrangler.toml [triggers].
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await pruneExpired(env.DB, Math.floor(Date.now() / 1000));
  },
};
// Also export the raw Hono app so tests that dispatch via `app.request(...)`
// (rather than SELF.fetch) keep working after the default export became a
// `{ fetch, scheduled }` module object.
export { app };
export type { Env };
// Durable Object class must be exported from the worker entrypoint so the
// runtime can instantiate it for the PRESENCE binding (spec §3).
export { PresenceRoom } from "./social/presence-room";
