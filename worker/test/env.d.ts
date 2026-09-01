// Type the bindings tests read off `env` (env.DB, env.TEST_MIGRATIONS, ...).
// @cloudflare/vitest-pool-workers 0.20+ types cloudflare:test's `env` as the
// global `Cloudflare.Env` (from @cloudflare/workers-types 5) instead of the old
// module-local `ProvidedEnv`, so the augmentation moved to that namespace.
declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      TEST_MIGRATIONS: D1Migration[];
      GH_CLIENT_ID: string;
      GH_CLIENT_SECRET: string;
      ADMIN_USER_IDS: string;
      CUTOVER_TIMESTAMP: string;
      KNOWN_DEV_DEVICES?: string;
      PRESENCE: DurableObjectNamespace;
      SYNC_HUB: DurableObjectNamespace;
      CATALOG_INGEST_TOKEN?: string;
      CATALOG_ENABLED?: string;
      CATALOG_KV?: KVNamespace;
    }
  }
}
export {};
