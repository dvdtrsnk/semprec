import type { ModuleManifest } from "@semprec/module-registry";

/**
 * Deliberately declares a `queueAffinity` value outside `MODULE_TASK_AFFINITIES` (issue #91's
 * two composition roots only understand `'api'`/`'agents'`) — cast past `ModuleManifest`'s own
 * type, since `moduleManifestSchema.safeParse` (the runtime check `ModuleRegistry.loadModule`
 * actually applies) is what this fixture proves rejects it, not the TypeScript compiler.
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
