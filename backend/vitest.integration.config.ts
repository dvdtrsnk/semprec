import { configDefaults, defineConfig } from "vitest/config";

/**
 * Integration tier: every test here runs against one ephemeral, real Postgres instance
 * provisioned by `globalSetup` for the whole run (never a mocked DB) — see
 * `packages/data/src/testSupport/globalSetup.ts`. `*.unit.test.ts` files belong to the
 * unit tier (`vitest.unit.config.ts`) and are excluded here so the two tiers never overlap.
 */
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "modules/*/src/**/*.test.ts", "services/*/src/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "**/*.unit.test.ts"],
    globalSetup: ["./packages/data/src/testSupport/globalSetup.ts"],
    environment: "node",
    // Embedded Postgres cold-starts (initdb + start) take real wall-clock time.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
