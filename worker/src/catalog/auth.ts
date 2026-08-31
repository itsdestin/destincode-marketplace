// The gate on POST /admin/catalog/* — the hourly ingest job, not a person.
// A shared secret header rather than a session, because the caller is a GitHub
// Action with no GitHub identity of its own. The admin *reads* (health) stay on
// the normal person-shaped admin gate.
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { HonoEnv } from "../types";
import { unauthorized } from "../lib/errors";

// Constant-time string compare — a plain === leaks the mismatch position through
// how long it takes to return, which is enough to guess a secret byte by byte.
function sameSecret(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

/** Gate for POST /admin/catalog/* — the ingest job, not a user. */
export const requireIngestToken: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const expected = c.env.CATALOG_INGEST_TOKEN ?? "";
  // No secret configured is a deployment state, not a caller mistake — 503 says
  // "this endpoint is not usable right now" rather than blaming the credential.
  if (!expected) throw new HTTPException(503, { message: "ingest token not configured" });
  const given = c.req.header("X-Catalog-Token") ?? "";
  if (!given) throw unauthorized("missing ingest token");
  if (!sameSecret(given, expected)) throw unauthorized("invalid ingest token");
  return next();
};
