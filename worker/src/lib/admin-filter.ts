// SQL fragment helpers for admin analytics queries. Both helpers return
// strings that are safe to interpolate into a SQL query because they
// strictly sanitize the values they pull from env vars.
//
// Why strings, not parameterized queries: Cloudflare's AE SQL endpoint
// takes raw text/plain SQL; there's no parameter binding API.
import type { Env } from "../types";

// Returns "AND blob2 NOT IN ('hash1','hash2',...)" or "" if filter disabled.
// Each comma-separated token is scanned for exactly one run of 64 consecutive
// hex characters — the first such run is the hash. Any surrounding injection
// characters (apostrophes, semicolons, SQL keywords) are non-hex and thus
// not captured. Tokens with no 64-hex run are dropped.
export function adminFilterClause(env: Env, includeAdmins: boolean): string {
  if (includeAdmins) return "";
  const raw = env.KNOWN_DEV_DEVICES ?? "";
  if (!raw) return "";
  // Match the first run of exactly 64 hex chars from each comma-separated token.
  // The negative lookahead/lookbehind prevent matching a substring of a longer
  // hex run (e.g. 128-char token should not produce a truncated hash).
  const EXACT_64_HEX = /(?<![a-f0-9])([a-f0-9]{64})(?![a-f0-9])/i;
  const hashes = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((token) => {
      const captured = token.match(EXACT_64_HEX)?.[1];
      return captured ? captured.toLowerCase() : null;
    })
    .filter((h): h is string => h !== null)
    .map((h) => `'${h}'`);
  if (!hashes.length) return "";
  return `AND blob2 NOT IN (${hashes.join(",")})`;
}

// Returns "AND timestamp > toDateTime('<iso>')" or "" if cutover disabled.
// Extracts the first ISO-8601 date/datetime from the raw value — injection
// characters surrounding or appended to a valid date are non-ISO and thus
// not captured by the extraction regex.
export function cutoverClause(env: Env): string {
  const raw = env.CUTOVER_TIMESTAMP ?? "";
  if (!raw) return "";
  // Extract the first ISO-8601 date or datetime from the raw string.
  // Accepted forms: YYYY-MM-DD, YYYY-MM-DDTHH:MM:SSZ, etc.
  // Apostrophes, semicolons, SQL keywords, and "--" are not in the charset
  // [0-9T:\-Z.] so they break the match boundary automatically.
  const match = raw.match(
    /(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?)/
  );
  if (!match) return "";
  return `AND timestamp > toDateTime('${match[1]}')`;
}
