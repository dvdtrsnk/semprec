import type { ModuleManifest } from "@semprec/module-registry";

export const manifest: ModuleManifest = {
  id: "fixture-transcribe-queue-runtime",
  version: "1.0.0",
  name: "Fixture Transcribe Queue Runtime",
  removable: true,
  systemProject: true,
  databases: [],
  capabilities: [],
  agentTools: [],
  taskNames: [
    {
      name: "transcribeFixture.doThing",
      payloadSchemaExport: "doThingPayloadSchema",
      handlerExport: "handleDoThing",
      queueAffinity: "transcribe",
    },
  ],
};

export const doThingPayloadSchema = { parse: (value: unknown) => value };

export async function handleDoThing(): Promise<void> {}
