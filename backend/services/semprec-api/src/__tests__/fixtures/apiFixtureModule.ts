import type { ModuleManifest } from "@semprec/module-registry";

export const manifest: ModuleManifest = {
  id: "fixture-api-queue-runtime",
  version: "1.0.0",
  name: "Fixture API Queue Runtime",
  removable: true,
  systemProject: true,
  databases: [],
  capabilities: [],
  agentTools: [],
  taskNames: [
    {
      name: "apiFixture.doThing",
      payloadSchemaExport: "doThingPayloadSchema",
      handlerExport: "handleDoThing",
      queueAffinity: "api",
    },
  ],
};

export const doThingPayloadSchema = { parse: (value: unknown) => value };

export const calls: unknown[] = [];

export async function handleDoThing(payload: unknown): Promise<void> {
  calls.push(payload);
}
