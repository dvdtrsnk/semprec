import { configDefaults, defineConfig } from "vitest/config";

/**
 * Integration tier: every test here runs against one ephemeral, real Postgres instance
 * provisioned by `globalSetup` for the whole run (never a mocked DB) — see
 * `packages/data/src/testSupport/globalSetup.ts`. `*.unit.test.ts` files belong to the
 * unit tier (`vitest.unit.config.ts`) and `*.e2e.test.ts` files belong to the e2e tier
 * (`vitest.e2e.config.ts`) — both are excluded here so no test file runs in more than one tier.
 */
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "services/*/src/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "**/*.unit.test.ts", "**/*.e2e.test.ts"],
    globalSetup: ["./packages/data/src/testSupport/globalSetup.ts"],
    environment: "node",
    // Issue #1199: warn-level output, chiefly tenant_scope_missing, can exceed
    // Relay's output limit and hide real failures. Preserve developer overrides.
    env: { LOG_LEVEL: process.env.LOG_LEVEL ?? "error" },
    // Embedded Postgres cold-starts (initdb + start) take real wall-clock time.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
