import type { ModuleManifest } from "../../manifest.js";

export const manifest: ModuleManifest = {
  id: "fixture-link-cross-cycle",
  version: "1.0.0",
  name: "Fixture Link Cross Cycle",
  removable: true,
  systemProject: false,
  databases: [{ key: "linkBItems", name: "Link B Items" }],
  capabilities: [],
  agentTools: [],
  linkRules: [
    {
      key: "fixtureLink.bToA",
      source: { databaseKey: "linkBItems", propertyKey: "y" },
      target: { databaseKey: "linkAItems", propertyKey: "x" },
      via: { databaseKey: "linkBItems", relationKey: "parentA" },
    },
  ],
};
