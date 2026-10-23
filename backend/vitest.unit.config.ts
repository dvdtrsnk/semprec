import { defineConfig } from "vitest/config";

/**
 * Unit tier: no `globalSetup`, no `TEST_DATABASE_URL` — a test file here must not import
 * anything that touches Postgres (directly or via `testSupport/testDb.ts`). See
 * `vitest.integration.config.ts` for the real-database tier.
 */
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.unit.test.ts", "services/*/src/**/*.unit.test.ts"],
    environment: "node",
    // Unit tests such as `traceEnvelope.unit.test.ts` call data-layer functions (`enqueueJob`)
    // without a tenant scope, and an unset mode is strict since issue #1067.
    env: { SEMPREC_TENANT_SCOPE: "warn" },
  },
});
