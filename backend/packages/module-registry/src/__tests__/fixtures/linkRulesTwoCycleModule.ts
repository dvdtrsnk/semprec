import type { ModuleManifest } from "../../manifest.js";

export const manifest: ModuleManifest = {
  id: "fixture-link-two-cycle",
  version: "1.0.0",
  name: "Fixture Link Two Cycle",
  removable: true,
  systemProject: false,
  databases: [{ key: "linkTwoCycleItems", name: "Link Two Cycle Items" }],
  capabilities: [],
  agentTools: [],
  linkRules: [
    {
      key: "fixtureLink.twoCycle1",
      source: { databaseKey: "linkTwoCycleItems", propertyKey: "a" },
      target: { databaseKey: "linkTwoCycleItems", propertyKey: "b" },
      via: { databaseKey: "linkTwoCycleItems", relationKey: "parent" },
    },
    {
      key: "fixtureLink.twoCycle2",
      source: { databaseKey: "linkTwoCycleItems", propertyKey: "b" },
      target: { databaseKey: "linkTwoCycleItems", propertyKey: "a" },
      via: { databaseKey: "linkTwoCycleItems", relationKey: "parent" },
    },
  ],
};
