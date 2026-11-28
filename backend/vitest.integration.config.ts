import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

/**
 * Integration tier: runs against one real ephemeral Postgres provisioned by `globalSetup`
 * (`packages/data/src/testSupport/globalSetup.ts`). Unit and e2e test files are excluded so no
 * file runs in more than one tier. Files run in parallel workers, each on its own database cloned from the
 * migrated template (`workerDatabase.ts`).
 */

/** `ALLDOTS_TEST_WORKERS` pins the count; by default half the cores, at most 6, since Postgres needs the rest. */
function integrationWorkers(): number {
  const configured = process.env.ALLDOTS_TEST_WORKERS;
  if (configured !== undefined) {
    const workers = Number(configured);
    if (!Number.isInteger(workers) || workers < 1 || workers > 64) {
      throw new Error(`ALLDOTS_TEST_WORKERS is not a worker count between 1 and 64: ${configured}`);
    }
    return workers;
  }
  return Math.max(1, Math.min(6, Math.floor(availableParallelism() / 2)));
}
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
    include: ["packages/*/src/**/*.test.ts", "services/*/src/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "**/*.unit.test.ts", "**/*.e2e.test.ts"],
    globalSetup: ["./packages/data/src/testSupport/globalSetup.ts"],
    setupFiles: [
      // Gives the file its worker's database and holds the cluster lock (shared, or exclusive for role changers).
      "./packages/data/src/testSupport/workerDatabase.ts",
      // Sets ALLDOTS_TENANT_SCOPE for each test file: `warn` for the files on the shrink-only list, `strict` otherwise.
      "./packages/data/src/testSupport/tenantScopeMode.ts",
    ],
    // The value this vitest process was started with, read here before `globalSetup` runs, so that
    // `tenantScopeModeDefault.test.ts` can tell a developer override from a default that some setup step applied.
    provide: { explicitTenantScopeMode: process.env.ALLDOTS_TENANT_SCOPE ?? null },
    environment: "node",
    // Warn-level output, chiefly tenant_scope_missing, can exceed
    // Relay's output limit and hide real failures. Preserve developer overrides.
    env: { LOG_LEVEL: process.env.LOG_LEVEL ?? "error" },
    // Embedded Postgres cold starts and the heaviest fan-out cases take 10 to 20 s locally and more on hosted runners.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: true,
    maxWorkers: integrationWorkers(),
  },
});
