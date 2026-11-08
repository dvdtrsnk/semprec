import type { ModuleManifest } from "../../manifest.js";

export const manifest: ModuleManifest = {
  id: "fixture-reclaims-partial-first",
  version: "1.0.0",
  name: "Fixture Reclaims Partial First",
  removable: true,
  systemProject: false,
  databases: [{ key: "fixturePartialFirst", name: "Reclaimed" }],
  capabilities: [],
  agentTools: [],
};
