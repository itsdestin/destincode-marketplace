export interface Env {
  DB: D1Database;
  AI: Ai;
  // Optional: omitted in [env.test] (vitest-pool-workers can't resolve AE binding).
  // All callers must use env.APP_ANALYTICS?.writeDataPoint() to stay test-safe.
  APP_ANALYTICS?: AnalyticsEngineDataset;
  GH_CLIENT_ID: string;
  GH_CLIENT_SECRET: string;
  ADMIN_USER_IDS: string;  // comma-separated user ids
  // Cloudflare Analytics Engine SQL API credentials used ONLY by admin analytics
  // routes. CF_ANALYTICS_TOKEN is a narrow-scope token (Analytics Engine: Read)
  // distinct from the broader CF_API_TOKEN used by CI for `wrangler deploy`.
  CF_ACCOUNT_ID: string;
  CF_ANALYTICS_TOKEN: string;
  // ISO-8601 timestamp of when the device-id-keyed client became dominant.
  // Empty string until Task 16 sets it — queries treat "" as epoch (no filter).
  CUTOVER_TIMESTAMP: string;
}

export interface UserRow {
  id: string;
  github_login: string;
  github_avatar_url: string | null;
  created_at: number;
}

export interface SessionRow {
  token_hash: string;
  user_id: string;
  created_at: number;
  last_used_at: number;
}

export interface RatingRow {
  user_id: string;
  plugin_id: string;
  stars: number;
  review_text: string | null;
  created_at: number;
  updated_at: number;
  hidden: number;
}

export type HonoEnv = { Bindings: Env; Variables: { userId: string } };
