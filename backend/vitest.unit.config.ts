import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Unit tier: no `globalSetup` and no database; a test file here must not import anything that touches Postgres. */
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
        find: /^@semprec\/data$/,
        replacement: fileURLToPath(new URL("./packages/data/src/index.ts", import.meta.url)),
      },
      {
        find: /^@semprec\/realtime$/,
        replacement: fileURLToPath(new URL("./packages/realtime/src/index.ts", import.meta.url)),
      },
      {
        find: /^@semprec\/application$/,
        replacement: fileURLToPath(new URL("./packages/application/src/index.ts", import.meta.url)),
      },
      {
        find: /^@semprec\/notifications$/,
        replacement: fileURLToPath(new URL("./packages/notifications/src/index.ts", import.meta.url)),
      },
      {
        find: /^@semprec\/ai-gateway-client$/,
        replacement: fileURLToPath(new URL("./packages/ai-gateway-client/src/index.ts", import.meta.url)),
      },
      {
        find: /^@semprec\/ai-gateway$/,
        replacement: fileURLToPath(new URL("./packages/ai-gateway/src/index.ts", import.meta.url)),
      },
      {
        find: /^@semprec\/agent-runtime$/,
        replacement: fileURLToPath(new URL("./packages/agent-runtime/src/index.ts", import.meta.url)),
      },
      {
        find: /^@semprec\/credentials$/,
        replacement: fileURLToPath(new URL("./packages/credentials/src/index.ts", import.meta.url)),
      },
      {
        find: /^@semprec\/shared\/src\/logger\.js$/,
        replacement: fileURLToPath(new URL("./packages/shared/src/logger.ts", import.meta.url)),
      },
    ],
  },
  test: {
    include: ["packages/*/src/**/*.unit.test.ts", "services/*/src/**/*.unit.test.ts"],
    environment: "node",
    // Unit tests such as `traceEnvelope.unit.test.ts` call `enqueueJob` without a tenant scope; an unset mode is strict.
    env: { SEMPREC_TENANT_SCOPE: "warn" },
  },
});
