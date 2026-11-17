import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runInTenant } from "@semprec/shared";
import { ensureQueueSchema } from "@semprec/queue";
import { ModuleRegistry } from "@semprec/module-registry";
import { BLOCK_TYPES } from "@semprec/block-model";
import { resolveMasterKeyFromEnv } from "@semprec/credentials";

it("resolves workspace roots to source modules in the e2e tier", async () => {
  const sharedPath = fileURLToPath(new URL("../../../shared/src/index.ts", import.meta.url));
  const queuePath = fileURLToPath(new URL("../../../queue/src/index.ts", import.meta.url));
  const registryPath = fileURLToPath(new URL("../../../module-registry/src/index.ts", import.meta.url));
  const blockPath = fileURLToPath(new URL("../../../../../shared/block-model/src/index.ts", import.meta.url));
  const sourceRunInTenant: unknown = (await import(sharedPath)).runInTenant;
  const sourceEnsureQueueSchema: unknown = (await import(queuePath)).ensureQueueSchema;
  const SourceModuleRegistry: unknown = (await import(registryPath)).ModuleRegistry;
  const credentialsPath = fileURLToPath(new URL("../../../credentials/src/index.ts", import.meta.url));
  const sourceBlockTypes: unknown = (await import(blockPath)).BLOCK_TYPES;
  const sourceResolveMasterKeyFromEnv: unknown = (await import(credentialsPath)).resolveMasterKeyFromEnv;
  expect(runInTenant).toBe(sourceRunInTenant);
  expect(ensureQueueSchema).toBe(sourceEnsureQueueSchema);
  expect(ModuleRegistry).toBe(SourceModuleRegistry);
  expect(BLOCK_TYPES).toBe(sourceBlockTypes);
  expect(resolveMasterKeyFromEnv).toBe(sourceResolveMasterKeyFromEnv);
});
