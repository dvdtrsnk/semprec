import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

/**
 * Integration tier: every test here runs against one ephemeral, real Postgres instance
 * provisioned by `globalSetup` for the whole run (never a mocked DB) — see
 * `packages/data/src/testSupport/globalSetup.ts`. `*.unit.test.ts` files belong to the
 * unit tier (`vitest.unit.config.ts`) and `*.e2e.test.ts` files belong to the e2e tier
 * (`vitest.e2e.config.ts`) — both are excluded here so no test file runs in more than one tier.
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
    include: ["packages/*/src/**/*.test.ts", "services/*/src/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "**/*.unit.test.ts", "**/*.e2e.test.ts"],
    globalSetup: ["./packages/data/src/testSupport/globalSetup.ts"],
    // Sets SEMPREC_TENANT_SCOPE for each test file: `warn` for the files on the shrink-only list, `strict` otherwise.
    setupFiles: ["./packages/data/src/testSupport/tenantScopeMode.ts"],
    // The value this vitest process was started with, read here before `globalSetup` runs, so that
    // `tenantScopeModeDefault.test.ts` can tell a developer override from a default that some setup step applied.
    provide: { explicitTenantScopeMode: process.env.SEMPREC_TENANT_SCOPE ?? null },
    environment: "node",
    // Issue #1199: warn-level output, chiefly tenant_scope_missing, can exceed
    // Relay's output limit and hide real failures. Preserve developer overrides.
    env: { LOG_LEVEL: process.env.LOG_LEVEL ?? "error" },
    // Embedded Postgres cold-starts (initdb + start) take real wall-clock time, and the heaviest cutover
    // and fan-out cases take 10 to 20 s alone on a developer machine; on a hosted runner that is more
    // than the former 30 s (observed on PR2057, PR2059, PR2060 and PR2062).
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
