import { defineConfig } from "vitest/config";

/**
 * E2e tier (module-contract issue #114): a small number of scenarios that load real modules
 * through `@semprec/module-registry`, wire them into the real queue and a real Postgres
 * instance the same way a production composition root would, and assert on cross-module
 * behavior no single package's own test suite exercises. Named `*.e2e.test.ts` and excluded
 * from `vitest.integration.config.ts` so a scenario here never doubles as an integration test.
 * Reuses the integration tier's `globalSetup` since it needs the same real, ephemeral Postgres.
 */
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.e2e.test.ts", "modules/*/src/**/*.e2e.test.ts", "services/*/src/**/*.e2e.test.ts"],
    globalSetup: ["./packages/data/src/testSupport/globalSetup.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
