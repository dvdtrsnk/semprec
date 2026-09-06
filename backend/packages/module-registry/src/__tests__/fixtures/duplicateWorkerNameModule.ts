import type { ModuleManifest } from "../../manifest.js";

export const manifest: ModuleManifest = {
  id: "fixture-duplicate-worker-name",
  version: "1.0.0",
  name: "Fixture Duplicate Worker Name",
  removable: true,
  systemProject: false,
  databases: [],
  capabilities: [],
  agentTools: [],
  workers: [{ name: "fixtureGood.worker", handlerExport: "runWorker" }],
};

export function runWorker(): void {}
