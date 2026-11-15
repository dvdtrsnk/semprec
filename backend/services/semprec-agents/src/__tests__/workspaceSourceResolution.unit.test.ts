import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createHttpAiGatewayClient } from "@semprec/ai-gateway-client";

// The path is spelled out for a dynamic import: a static relative import across packages fails `tsc` with TS6059
// under this service's `rootDir: src`. `@semprec/ai-gateway-client` has no PostgreSQL graph, so the unit tier can
// prove its identity; the roots that reach `@semprec/data` are proved in the e2e tier.
it("resolves @semprec/ai-gateway-client to its source module in the unit tier", async () => {
  const sourcePath = fileURLToPath(new URL("../../../../packages/ai-gateway-client/src/index.ts", import.meta.url));
  const sourceCreateHttpAiGatewayClient: unknown = (await import(sourcePath)).createHttpAiGatewayClient;
  expect(createHttpAiGatewayClient).toBe(sourceCreateHttpAiGatewayClient);
});
