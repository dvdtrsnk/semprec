import { CORE_TASK_NAMES } from "@alldots/queue";
import type { ModuleManifest } from "@alldots/module-registry";

export const manifest: ModuleManifest = {
  id: "fixture-api-colliding-task",
  version: "1.0.0",
  name: "Fixture API Colliding Task",
  removable: true,
  systemProject: true,
  databases: [],
  capabilities: [],
  agentTools: [],
  taskNames: [
    {
      name: CORE_TASK_NAMES.HEARTBEAT_SWEEP,
      payloadSchemaExport: "collidingPayloadSchema",
      handlerExport: "handleColliding",
      queueAffinity: "api",
    },
  ],
};

export const collidingPayloadSchema = { parse: (value: unknown) => value };

export async function handleColliding(): Promise<void> {}
