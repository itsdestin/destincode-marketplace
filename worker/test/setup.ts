import { env, applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach } from "vitest";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Vitest 4 + @cloudflare/vitest-pool-workers 0.20+ isolate storage per test FILE,
// not per test — the `isolatedStorage` / `singleWorker` options are gone. Every
// test in this suite was written against per-test isolation (a fresh D1, KV and
// Durable Objects each `it`), and without it three of them read sibling tests'
// leftovers: `SELECT COUNT(*) FROM friendships` saw 3 rows, GET /catalog served
// a KV object a previous test had published. `reset()` is the integration's own
// replacement — "deletes all data from all attached bindings" (D1, KV, DO
// storage, and it tears the DO instances down) — so re-applying the migrations
// afterwards gives each test exactly the empty schema it always had. Measured:
// the full run is no slower than before (~11s for 304 tests).
//
// One visible side effect: workerd logs a handful of
// `jsg.Error: Application called deleteAllDurableObjects()` lines when a test
// leaves a PresenceRoom / SyncGroupRoom WebSocket open — that is the DO being
// torn down under a live socket, which is exactly what the reset is for. Those
// lines are noise, not failures; the test summary is the verdict.
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

// NOTE (verified 2026-08-28, by probing `c.env.AI` from inside a request): a
// Workers AI stub CANNOT be injected from here. `[env.test]` omits the `[ai]`
// binding, and assigning `(env as any).AI` in this file does NOT propagate —
// inside a request `c.env.AI` is `undefined`, while `env.AI` in a test body is
// an object. The previous stub here claimed the opposite and had never worked.
//
// Consequence: `classifyReview()` always takes its fail-open branch under
// vitest, so NO route test can exercise the "flagged → hidden = 1" path. Test
// the classifier directly instead — it takes `ai` as a parameter, so a fake
// object needs no bindings at all (see `moderation.test.ts`). Route
// tests cover the other half: a `hidden = 1` row is never listed.

// ADMIN_USER_IDS is configured in wrangler.toml's [env.test.vars] block —
// mutating `env` here does not propagate to `c.env` inside the worker, which is
// the same reason the AI stub above was impossible. Anything a request must see
// has to come from wrangler config.
