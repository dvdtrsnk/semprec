import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { repairInterruptedRuns } from "@semprec/agent-runtime";

// The path is spelled out for a dynamic import: a static relative import across packages fails `tsc` with TS6059
// under this service's `rootDir: src`. `@semprec/agent-runtime` reaches `@semprec/data`, so its identity is
// proved here and not in the unit tier.
it("resolves @semprec/agent-runtime to its source module in the e2e tier", async () => {
  const sourcePath = fileURLToPath(new URL("../../../../packages/agent-runtime/src/index.ts", import.meta.url));
  const sourceRepairInterruptedRuns: unknown = (await import(sourcePath)).repairInterruptedRuns;
  expect(repairInterruptedRuns).toBe(sourceRepairInterruptedRuns);
});
