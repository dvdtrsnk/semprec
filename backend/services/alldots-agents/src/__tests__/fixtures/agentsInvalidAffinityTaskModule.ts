import type { ModuleManifest } from "@alldots/module-registry";

/** An invalid `queueAffinity`, cast past the type so the runtime `moduleManifestSchema` check is what rejects it. */
export const manifest = {
  id: "fixture-agents-invalid-affinity-task",
  version: "1.0.0",
  name: "Fixture Agents Invalid Affinity Task",
  removable: true,
  systemProject: true,
  databases: [],
  capabilities: [],
  agentTools: [],
  taskNames: [
    {
      name: "agentsFixture.invalidAffinityThing",
      payloadSchemaExport: "invalidAffinityPayloadSchema",
      handlerExport: "handleInvalidAffinity",
      queueAffinity: "not-a-real-affinity",
    },
  ],
} as unknown as ModuleManifest;

export const invalidAffinityPayloadSchema = { parse: (value: unknown) => value };

export async function handleInvalidAffinity(): Promise<void> {}
