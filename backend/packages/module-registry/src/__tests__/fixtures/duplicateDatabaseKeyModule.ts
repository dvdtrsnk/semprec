import type { ModuleManifest } from "../../manifest.js";

export const manifest: ModuleManifest = {
  id: "fixture-duplicate-db-key",
  version: "1.0.0",
  name: "Fixture Duplicate DB Key",
  removable: true,
  systemProject: false,
  databases: [{ key: "fixtureGoodItems", name: "Colliding Database" }],
  capabilities: [],
  agentTools: [],
};
