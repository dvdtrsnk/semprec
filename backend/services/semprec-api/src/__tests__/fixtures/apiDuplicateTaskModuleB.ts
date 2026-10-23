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
      // Deliberately the same task name as apiDuplicateTaskModuleA.ts, so loading both into one
      // registry proves the shared ModuleRegistry (issue #221) rejects a duplicate task name
      // across two modules before either of #91's composition roots ever run.
      name: "apiFixture.dupThing",
      payloadSchemaExport: "dupThingPayloadSchema",
      handlerExport: "handleDupThing",
      queueAffinity: "api",
    },
  ],
};

export const dupThingPayloadSchema = { parse: (value: unknown) => value };

export async function handleDupThing(): Promise<void> {}
