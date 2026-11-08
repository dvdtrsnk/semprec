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
      // Deliberately the same task name as agentsDuplicateTaskModuleA.ts, so loading both into
      // one registry proves the shared ModuleRegistry (issue #221) rejects a duplicate task name
      // across two modules before either of #91's composition roots ever run.
      name: "agentsFixture.dupThing",
      payloadSchemaExport: "dupThingPayloadSchema",
      handlerExport: "handleDupThing",
      queueAffinity: "agents",
    },
  ],
};

export const dupThingPayloadSchema = { parse: (value: unknown) => value };

export async function handleDupThing(): Promise<void> {}
