import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createPool } from "@semprec/data";
import { wireRealtimeHooks } from "@semprec/realtime";
import { createGenericApplicationService } from "@semprec/application";
import { createNotification } from "@semprec/notifications";
import { createHttpAiGatewayClient } from "@semprec/ai-gateway-client";

// One stable export per root, compared with the same export of an `import()` of the source path: a root that
// resolved to `dist` through its package manifest would hand back a different object. The path is spelled out
// for a dynamic import because a static relative import across packages fails `tsc` with TS6059 under this
// service's `rootDir: src`.
it("resolves the workspace roots of semprec-api to source modules in the e2e tier", async () => {
  const dataPath = fileURLToPath(new URL("../../../../packages/data/src/index.ts", import.meta.url));
  const realtimePath = fileURLToPath(new URL("../../../../packages/realtime/src/index.ts", import.meta.url));
  const applicationPath = fileURLToPath(new URL("../../../../packages/application/src/index.ts", import.meta.url));
  const notificationsPath = fileURLToPath(new URL("../../../../packages/notifications/src/index.ts", import.meta.url));
  const gatewayClientPath = fileURLToPath(
    new URL("../../../../packages/ai-gateway-client/src/index.ts", import.meta.url),
  );
  const sourceCreatePool: unknown = (await import(dataPath)).createPool;
  const sourceWireRealtimeHooks: unknown = (await import(realtimePath)).wireRealtimeHooks;
  const sourceCreateGenericApplicationService: unknown = (await import(applicationPath))
    .createGenericApplicationService;
  const sourceCreateNotification: unknown = (await import(notificationsPath)).createNotification;
  const sourceCreateHttpAiGatewayClient: unknown = (await import(gatewayClientPath)).createHttpAiGatewayClient;
  expect(createPool).toBe(sourceCreatePool);
  expect(wireRealtimeHooks).toBe(sourceWireRealtimeHooks);
  expect(createGenericApplicationService).toBe(sourceCreateGenericApplicationService);
  expect(createNotification).toBe(sourceCreateNotification);
  expect(createHttpAiGatewayClient).toBe(sourceCreateHttpAiGatewayClient);
});
