import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { complete } from "@semprec/ai-gateway";

// The path is spelled out for a dynamic import: a static relative import across packages fails `tsc` with TS6059
// under this service's `rootDir: src`. `@semprec/ai-gateway` reaches `@semprec/data`, so its identity is proved
// here and not in the unit tier.
it("resolves @semprec/ai-gateway to its source module in the e2e tier", async () => {
  const sourcePath = fileURLToPath(new URL("../../../../packages/ai-gateway/src/index.ts", import.meta.url));
  const sourceComplete: unknown = (await import(sourcePath)).complete;
  expect(complete).toBe(sourceComplete);
});
