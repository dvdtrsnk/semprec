import type { ModuleManifest } from "@semprec/module-registry";

/**
 * A `queueAffinity` outside `MODULE_TASK_AFFINITIES`, cast past `ModuleManifest`'s type: the runtime check
 * `moduleManifestSchema.safeParse` in `ModuleRegistry.loadModule` is what must reject it.
 */
export const manifest = {
  id: "fixture-api-invalid-affinity-task",
  version: "1.0.0",
  name: "Fixture API Invalid Affinity Task",
  removable: true,
  systemProject: true,
  databases: [],
  capabilities: [],
  agentTools: [],
  taskNames: [
    {
      name: "apiFixture.invalidAffinityThing",
      payloadSchemaExport: "invalidAffinityPayloadSchema",
      handlerExport: "handleInvalidAffinity",
      queueAffinity: "not-a-real-affinity",
    },
  ],
} as unknown as ModuleManifest;

export const invalidAffinityPayloadSchema = { parse: (value: unknown) => value };

export async function handleInvalidAffinity(): Promise<void> {}
