import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * E2e tier: scenarios that load real modules through `@alldots/module-registry`, wire them into the
 * real queue and Postgres as a composition root would, and assert cross-module behavior. Excluded
 * from the integration tier; reuses its `globalSetup`.
 */
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@alldots\/shared$/,
        replacement: fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url)),
      },
      {
        find: /^@alldots\/queue$/,
        replacement: fileURLToPath(new URL("./packages/queue/src/index.ts", import.meta.url)),
      },
      {
        find: /^@alldots\/module-registry$/,
        replacement: fileURLToPath(new URL("./packages/module-registry/src/index.ts", import.meta.url)),
      },
      {
        find: /^@alldots\/block-model$/,
        replacement: fileURLToPath(new URL("../shared/block-model/src/index.ts", import.meta.url)),
      },
      {
        find: /^@alldots\/data$/,
        replacement: fileURLToPath(new URL("./packages/data/src/index.ts", import.meta.url)),
      },
      {
        find: /^@alldots\/realtime$/,
        replacement: fileURLToPath(new URL("./packages/realtime/src/index.ts", import.meta.url)),
      },
      {
        find: /^@alldots\/application$/,
        replacement: fileURLToPath(new URL("./packages/application/src/index.ts", import.meta.url)),
      },
      {
        find: /^@alldots\/notifications$/,
        replacement: fileURLToPath(new URL("./packages/notifications/src/index.ts", import.meta.url)),
      },
      {
        find: /^@alldots\/ai-gateway-client$/,
        replacement: fileURLToPath(new URL("./packages/ai-gateway-client/src/index.ts", import.meta.url)),
      },
      {
        find: /^@alldots\/ai-gateway$/,
        replacement: fileURLToPath(new URL("./packages/ai-gateway/src/index.ts", import.meta.url)),
      },
      {
        find: /^@alldots\/agent-runtime$/,
        replacement: fileURLToPath(new URL("./packages/agent-runtime/src/index.ts", import.meta.url)),
      },
      {
        find: /^@alldots\/credentials$/,
        replacement: fileURLToPath(new URL("./packages/credentials/src/index.ts", import.meta.url)),
      },
      {
        find: /^@alldots\/shared\/src\/logger\.js$/,
        replacement: fileURLToPath(new URL("./packages/shared/src/logger.ts", import.meta.url)),
      },
    ],
  },
  test: {
    include: ["packages/*/src/**/*.e2e.test.ts", "services/*/src/**/*.e2e.test.ts"],
    globalSetup: ["./packages/data/src/testSupport/globalSetup.ts"],
    environment: "node",
    // Warn-level output, chiefly tenant_scope_missing, can exceed
    // Relay's output limit and hide real failures. Preserve developer overrides.
    // The e2e tier keeps `warn` because its scenarios still write through fixtures outside any scope; pinned here as
    // `vitest.unit.config.ts` pins the unit tier.
    env: {
      LOG_LEVEL: process.env.LOG_LEVEL ?? "error",
      ALLDOTS_TENANT_SCOPE: process.env.ALLDOTS_TENANT_SCOPE ?? "warn",
    },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
