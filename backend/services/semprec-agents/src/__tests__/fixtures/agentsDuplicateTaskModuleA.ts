import type { ModuleManifest } from "@semprec/module-registry";

export const manifest: ModuleManifest = {
  id: "fixture-agents-duplicate-task-a",
  version: "1.0.0",
  name: "Fixture Agents Duplicate Task A",
  removable: true,
  systemProject: true,
  databases: [],
  capabilities: [],
  agentTools: [],
  taskNames: [
    {
      name: "agentsFixture.dupThing",
      payloadSchemaExport: "dupThingPayloadSchema",
      handlerExport: "handleDupThing",
      queueAffinity: "agents",
    },
  ],
};

export const dupThingPayloadSchema = { parse: (value: unknown) => value };

export async function handleDupThing(): Promise<void> {}
