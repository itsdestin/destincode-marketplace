export interface Env {
  DB: D1Database;
  AI: Ai;
  // Single global PresenceRoom Durable Object (friends-only presence fan-out,
  // challenge relay, last_seen_at writes — spec §3). Bound in wrangler.toml.
  PRESENCE: DurableObjectNamespace;
  // Per-account SyncGroupRoom Durable Object (idFromName(userId)) — relays
  // metadata-only "space-updated" signals between a user's own devices so
  // pulls happen instantly instead of waiting for the 120s poll (SyncHub §6).
  SYNC_HUB: DurableObjectNamespace;
  // Optional: omitted in [env.test] (vitest-pool-workers can't resolve AE binding).
  // All callers must use env.APP_ANALYTICS?.writeDataPoint() to stay test-safe.
  APP_ANALYTICS?: AnalyticsEngineDataset;
  GH_CLIENT_ID: string;
  GH_CLIENT_SECRET: string;
  ADMIN_USER_IDS: string;  // comma-separated GitHub numeric ids (matched via identities — see src/auth/admin.ts)
  // Cloudflare Analytics Engine SQL API credentials used ONLY by admin analytics
  // routes. CF_ANALYTICS_TOKEN is a narrow-scope token (Analytics Engine: Read)
  // distinct from the broader CF_API_TOKEN used by CI for `wrangler deploy`.
  CF_ACCOUNT_ID: string;
  CF_ANALYTICS_TOKEN: string;
  // ISO-8601 timestamp of when the device-id-keyed client became dominant.
  // Empty string until Task 16 sets it — queries treat "" as epoch (no filter).
  CUTOVER_TIMESTAMP: string;
  // Comma-separated 64-hex SHA-256 hashes of known dev/admin device IDs.
  // Set via `wrangler secret put KNOWN_DEV_DEVICES` (Task 15) — absent until then.
  // adminFilterClause() uses these to exclude dev traffic from analytics queries.
  KNOWN_DEV_DEVICES?: string;
  // Presence ghost-socket staleness threshold in ms. Set ONLY in [env.test.vars]
  // so eviction is reachable in a test run; production omits it and uses the
  // generous in-code rollout default (presence-room.ts STALE_DEFAULT_MS).
  PRESENCE_STALE_MS?: string;
  // Shared secret the catalog-ingest GitHub Action presents on
  // POST /admin/catalog/*. Set by CI (wrangler secret put); [env.test.vars]
  // carries a fixed test value. Empty/absent -> those routes answer 503.
  CATALOG_INGEST_TOKEN?: string;
  // Kill switch for GET /catalog. "0" -> 503, which both clients already handle by
  // falling back to index.json. A bad ingest run reaches every device within the
  // hour; this is the way to stop it with a commit instead of a code change.
  CATALOG_ENABLED?: string;
  // Where the pre-built catalog object lives. OPTIONAL on purpose: GET /catalog
  // falls back to assembling the body out of D1 when the namespace is absent or
  // empty, so an unprovisioned binding degrades to slower, never to broken.
  CATALOG_KV?: KVNamespace;
}

// NOTE: full-row interfaces (UserRow/IdentityRow/SessionRow/RatingRow) used to
// live here and were removed 2026-07-22 as dead code. Every query in this worker
// declares its own inline shape for just the columns it SELECTs (e.g.
// `.first<{ user_id: string; last_used_at: number }>()` in auth/sessions.ts),
// so the whole-row types were never referenced. Keep that convention — an
// inline shape can't drift out of sync with the columns its query asks for.

export type HonoEnv = { Bindings: Env; Variables: { userId: string } };
