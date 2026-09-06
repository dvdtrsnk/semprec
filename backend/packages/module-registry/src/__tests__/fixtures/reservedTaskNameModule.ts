import type { ModuleManifest } from "../../manifest.js";

export const manifest: ModuleManifest = {
  id: "fixture-reserved-task-name",
  version: "1.0.0",
  name: "Fixture Reserved Task Name",
  removable: true,
  systemProject: false,
  databases: [],
  capabilities: [],
  agentTools: [],
  taskNames: [{ name: "heartbeatSweep", payloadSchemaExport: "payloadSchema", handlerExport: "handleTask" }],
};

export const payloadSchema = { parse: (value: unknown) => value };

export function handleTask(): void {}
