import type { ModuleManifest } from "../../manifest.js";

export const manifest: ModuleManifest = {
  id: "fixture-duplicate-task-name",
  version: "1.0.0",
  name: "Fixture Duplicate Task Name",
  removable: true,
  systemProject: false,
  databases: [],
  capabilities: [],
  agentTools: [],
  taskNames: [{ name: "fixtureGood.processThing", payloadSchemaExport: "payloadSchema", handlerExport: "handleTask" }],
};

export const payloadSchema = { parse: (value: unknown) => value };

export function handleTask(): void {}
