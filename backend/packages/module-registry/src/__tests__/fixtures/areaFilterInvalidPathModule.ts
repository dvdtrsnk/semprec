// Deliberately not typed as `ModuleManifest`: its one-hop `relation_path_contains` path is the invalid
// declaration the loader must refuse.
export const manifest = {
  id: "areaFilterInvalidPathFixture",
  version: "1.0.0",
  name: "Area filter invalid path fixture",
  removable: true,
  systemProject: false,
  databases: [
    {
      key: "invalidPathItems",
      name: "Invalid path items",
      areaFilter: { type: "relation_path_contains", path: ["project"], value: { areaValue: true } },
    },
  ],
  capabilities: [],
  agentTools: [],
};
