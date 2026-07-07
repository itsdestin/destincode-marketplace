// Resolves a GitHub PAT to a platform account id (acct_<hex>) by calling
// GitHub's /user endpoint and mapping the returned numeric id through the
// `identities` table. Used by requireAdminAuth when the caller is the
// youcoded-admin analytics skill (CLI-driven — can't participate in the
// browser OAuth cookie flow).
//
// The admin must have signed into the marketplace at least once so their
// github identity row exists; a PAT for an account we've never seen resolves
// to null (no identity → no account).
//
// Caching: 60s TTL per-token-hash of the resolved account id. Keeps repeated
// admin calls off GitHub's rate limit. Short enough that a revoked PAT stops
// working within a minute.
import type { D1Database } from "@cloudflare/workers-types";

interface CacheEntry {
  userId: string;
  expiresAt: number;
}

// Module-level Map — lives for the lifetime of the Worker isolate. Per-colo,
// like the existing rate-limit helper — fine for an admin-only path.
const patCache = new Map<string, CacheEntry>();

const TTL_MS = 60_000;

// Hash the PAT with SHA-256 so we never keep the raw token in memory beyond
// the duration of the fetch call.
async function hashToken(token: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function resolvePat(db: D1Database, token: string): Promise<string | null> {
  if (!token) return null;
  const key = await hashToken(token);
  const cached = patCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.userId;

  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "wecoded-marketplace-worker",
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) return null;  // do NOT cache failures — a rotated PAT can start working
  const user = (await res.json()) as { id: number };
  if (typeof user.id !== "number") return null;
  // Resolve the GitHub numeric id to the platform account via `identities`.
  // Id-format-independent — no provider-prefixed id string is constructed here.
  const row = await db
    .prepare("SELECT user_id FROM identities WHERE provider = 'github' AND provider_user_id = ?")
    .bind(String(user.id))
    .first<{ user_id: string }>();
  if (!row) return null;  // no linked account → treat as unresolvable (also not cached)
  patCache.set(key, { userId: row.user_id, expiresAt: Date.now() + TTL_MS });
  return row.user_id;
}

// Test-only helper to clear the module-level cache between runs.
export function __resetPatCacheForTests(): void {
  patCache.clear();
}
