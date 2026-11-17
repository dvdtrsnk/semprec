import type { ModuleManifest } from "@semprec/module-registry";

export const manifest: ModuleManifest = {
  id: "fixture-api-duplicate-task-b",
  version: "1.0.0",
  name: "Fixture API Duplicate Task B",
  removable: true,
  systemProject: true,
  databases: [],
  capabilities: [],
  agentTools: [],
  taskNames: [
    {
      // The same task name as apiDuplicateTaskModuleA.ts: the shared ModuleRegistry must reject the duplicate
      // across two modules before either composition root runs.
      name: "apiFixture.dupThing",
      payloadSchemaExport: "dupThingPayloadSchema",
      handlerExport: "handleDupThing",
      queueAffinity: "api",
    },
  ],
};

export const dupThingPayloadSchema = { parse: (value: unknown) => value };

export async function handleDupThing(): Promise<void> {}
