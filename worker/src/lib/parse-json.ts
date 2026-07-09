import type { Context } from "hono";
import { badRequest } from "./errors";

/**
 * Parse a JSON request body, turning malformed JSON into a 400 instead of a 500.
 *
 * Raw `c.req.json()` throws a plain SyntaxError on broken input, which
 * `app.onError` reports as a JSON 500. Routing body-parses through this
 * helper converts that into a proper `badRequest` (400) via the HTTPException
 * path, so clients see a client-error status for a client-error cause.
 *
 * Deliberate exception: the app-heartbeat route parses with `.catch(() => ({}))`
 * because it must tolerate junk from legacy clients (200 path) — do NOT "fix"
 * it to use this helper, that would change its semantics to a 400.
 */
export async function parseJsonBody<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw badRequest("request body must be valid JSON");
  }
}
