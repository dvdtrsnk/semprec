import type { ModuleManifest } from "../../manifest.js";
export const manifest: ModuleManifest = {
  id: "overviewHideableFixture",
  version: "1.0.0",
  name: "Overview hideable fixture",
  removable: true,
  systemProject: false,
  databases: [
    { key: "hideableItems", name: "Hideable items", overviewHideable: true },
    { key: "fixedItems", name: "Fixed items", overviewHideable: false },
    { key: "plainItems", name: "Plain items" },
  ],
  capabilities: [],
  agentTools: [],
};
