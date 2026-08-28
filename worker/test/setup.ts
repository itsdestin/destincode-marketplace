import { env, applyD1Migrations } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

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
