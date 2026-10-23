import type { ModuleManifest } from "../../manifest.js";

export const manifest: ModuleManifest = {
  id: "fixture-duplicate-tool-name",
  version: "1.0.0",
  name: "Fixture Duplicate Tool Name",
  removable: true,
  systemProject: false,
  databases: [],
  capabilities: [],
  agentTools: [{ name: "fixtureGood.doThing", handlerExport: "handleDoThing" }],
};

export function handleDoThing(): void {}
