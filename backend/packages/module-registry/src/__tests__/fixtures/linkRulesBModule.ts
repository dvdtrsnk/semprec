import type { ModuleManifest } from "../../manifest.js";

/** Shares its target property `linkBItems.y` with `fixtureLink.aToB` of the A fixture. */
export const manifest: ModuleManifest = {
  id: "fixture-link-b",
  version: "1.0.0",
  name: "Fixture Link B",
  removable: true,
  systemProject: false,
  databases: [{ key: "linkBItems", name: "Link B Items" }],
  capabilities: [],
  agentTools: [],
  linkRules: [
    {
      key: "fixtureLink.bToB",
      source: { databaseKey: "linkBItems", propertyKey: "w" },
      target: { databaseKey: "linkBItems", propertyKey: "y" },
      via: { databaseKey: "linkBItems", relationKey: "parentB" },
    },
  ],
};
