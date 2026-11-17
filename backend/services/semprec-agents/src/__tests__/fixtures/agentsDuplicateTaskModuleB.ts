import type { ModuleManifest } from "@semprec/module-registry";

export const manifest: ModuleManifest = {
  id: "fixture-agents-duplicate-task-b",
  version: "1.0.0",
  name: "Fixture Agents Duplicate Task B",
  removable: true,
  systemProject: true,
  databases: [],
  capabilities: [],
  agentTools: [],
  taskNames: [
    {
      // Same task name as agentsDuplicateTaskModuleA.ts, to prove ModuleRegistry rejects a
      // duplicate across modules before any composition root runs.
      name: "agentsFixture.dupThing",
      payloadSchemaExport: "dupThingPayloadSchema",
      handlerExport: "handleDupThing",
      queueAffinity: "agents",
    },
  ],
};

export const dupThingPayloadSchema = { parse: (value: unknown) => value };

export async function handleDupThing(): Promise<void> {}
