// Vitest 4 + @cloudflare/vitest-pool-workers 0.20+: the pool is now a Vite
// PLUGIN, not a `test.poolOptions.workers` block. `defineWorkersConfig` and the
// `@cloudflare/vitest-pool-workers/config` subpath no longer exist — the package
// ships a `vitest-v3-to-v4` codemod that performs exactly this rewrite. Every
// option below is unchanged from the pre-migration config; only where it lives
// moved (singleWorker / wrangler / miniflare → the `cloudflareTest()` argument).
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  plugins: [
    // The plugin accepts an async factory, which is where the D1 migrations are
    // read so `test/setup.ts` can apply them via the TEST_MIGRATIONS binding.
    cloudflareTest(async () => {
      const migrationsPath = path.join(__dirname, "migrations");
      const migrations = await readD1Migrations(migrationsPath);
      return {
        singleWorker: true,
        wrangler: { configPath: "./wrangler.toml", environment: "test" },
        miniflare: {
          compatibilityDate: "2024-09-23",
          compatibilityFlags: ["nodejs_compat"],
          bindings: { TEST_MIGRATIONS: migrations },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
