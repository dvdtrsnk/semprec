import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "modules/*/src/**/*.test.ts", "services/*/src/**/*.test.ts"],
    globalSetup: ["./packages/data/src/testSupport/globalSetup.ts"],
    environment: "node",
    // Embedded Postgres cold-starts (initdb + start) take real wall-clock time.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
