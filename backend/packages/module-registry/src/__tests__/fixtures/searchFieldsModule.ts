import type { ModuleManifest } from "../../manifest.js";
export const manifest: ModuleManifest = {
  id: "searchFixture",
  version: "1.0.0",
  name: "Search fixture",
  removable: true,
  systemProject: false,
  databases: [
    { key: "searchItems", name: "Search items", searchFields: ["name", "description", "missing"] },
    { key: "defaultItems", name: "Default items" },
    { key: "emptyItems", name: "Empty items", searchFields: [] },
  ],
  capabilities: [],
  agentTools: [],
};
