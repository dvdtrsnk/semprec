import type { ModuleManifest } from "@semprec/module-registry";

export const manifest: ModuleManifest = {
  id: "fixture-agents-queue-runtime",
  version: "1.0.0",
  name: "Fixture Agents Queue Runtime",
  removable: true,
  systemProject: true,
  databases: [],
  capabilities: [],
  agentTools: [],
  taskNames: [
    {
      name: "agentsFixture.doThing",
      payloadSchemaExport: "doThingPayloadSchema",
      handlerExport: "handleDoThing",
      queueAffinity: "agents",
    },
  ],
};

export const doThingPayloadSchema = { parse: (value: unknown) => value };

export const calls: unknown[] = [];

export async function handleDoThing(payload: unknown): Promise<void> {
  calls.push(payload);
}
