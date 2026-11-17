import type { ModuleManifest } from "../../manifest.js";

export const manifest: ModuleManifest = {
  id: "areaFilterFixture",
  version: "1.0.0",
  name: "Area filter fixture",
  removable: true,
  systemProject: false,
  databases: [
    {
      key: "areaFilteredItems",
      name: "Area filtered items",
      areaFilter: {
        type: "or",
        nodes: [
          { type: "relation_path_contains", path: ["project", "area"], value: { areaValue: true } },
          {
            type: "and",
            nodes: [
              { type: "relation_is_empty", property: "project" },
              { type: "relation_contains", property: "area", value: { areaValue: true } },
            ],
          },
        ],
      },
    },
    { key: "plainItems", name: "Plain items" },
  ],
  capabilities: [],
  agentTools: [],
};
