import { AGENT_TASK_NAMES } from "@alldots/queue";
import type { ModuleManifest } from "@alldots/module-registry";

export const manifest: ModuleManifest = {
  id: "fixture-agents-colliding-task",
  version: "1.0.0",
  name: "Fixture Agents Colliding Task",
  removable: true,
  systemProject: true,
  databases: [],
  capabilities: [],
  agentTools: [],
  taskNames: [
    {
      name: AGENT_TASK_NAMES.AGENT_RUN,
      payloadSchemaExport: "collidingPayloadSchema",
      handlerExport: "handleColliding",
      queueAffinity: "agents",
    },
  ],
};

export const collidingPayloadSchema = { parse: (value: unknown) => value };

export async function handleColliding(): Promise<void> {}
