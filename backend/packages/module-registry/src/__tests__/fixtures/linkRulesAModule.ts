import type { ModuleManifest } from "../../manifest.js";

export const manifest: ModuleManifest = {
  id: "fixture-link-a",
  version: "1.0.0",
  name: "Fixture Link A",
  removable: true,
  systemProject: false,
  databases: [{ key: "linkAItems", name: "Link A Items" }],
  capabilities: [],
  agentTools: [],
  linkRules: [
    {
      key: "fixtureLink.aToB",
      source: { databaseKey: "linkAItems", propertyKey: "x" },
      target: { databaseKey: "linkBItems", propertyKey: "y" },
      via: { databaseKey: "linkBItems", relationKey: "parentA" },
    },
  ],
};
