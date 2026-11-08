import { fileURLToPath } from "node:url";
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
  resolve: {
    alias: [
      {
        find: /^@semprec\/shared$/,
        replacement: fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url)),
      },
      {
        find: /^@semprec\/queue$/,
        replacement: fileURLToPath(new URL("./packages/queue/src/index.ts", import.meta.url)),
      },
      {
        find: /^@semprec\/module-registry$/,
        replacement: fileURLToPath(new URL("./packages/module-registry/src/index.ts", import.meta.url)),
      },
      {
        find: /^@semprec\/block-model$/,
        replacement: fileURLToPath(new URL("../shared/block-model/src/index.ts", import.meta.url)),
      },
      {
        find: /^@semprec\/shared\/src\/logger\.js$/,
        replacement: fileURLToPath(new URL("./packages/shared/src/logger.ts", import.meta.url)),
      },
    ],
  },
  test: {
    include: ["packages/*/src/**/*.e2e.test.ts", "services/*/src/**/*.e2e.test.ts"],
    globalSetup: ["./packages/data/src/testSupport/globalSetup.ts"],
    environment: "node",
    // Issue #1199: warn-level output, chiefly tenant_scope_missing, can exceed
    // Relay's output limit and hide real failures. Preserve developer overrides.
    env: { LOG_LEVEL: process.env.LOG_LEVEL ?? "error" },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
