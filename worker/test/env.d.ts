// Augment cloudflare:test ProvidedEnv so tests can reference env.DB / env.TEST_MIGRATIONS typed.
declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
    GH_CLIENT_ID: string;
    GH_CLIENT_SECRET: string;
    ADMIN_USER_IDS: string;
    CUTOVER_TIMESTAMP: string;
    KNOWN_DEV_DEVICES?: string;
    PRESENCE: DurableObjectNamespace;
  }
}
export {};
