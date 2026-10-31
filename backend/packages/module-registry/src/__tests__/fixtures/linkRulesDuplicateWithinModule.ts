import type { ModuleManifest } from "../../manifest.js";

export const manifest: ModuleManifest = {
  id: "fixture-link-duplicate-within",
  version: "1.0.0",
  name: "Fixture Link Duplicate Within",
  removable: true,
  systemProject: false,
  databases: [{ key: "linkDupWithinItems", name: "Link Dup Within Items" }],
  capabilities: [],
  agentTools: [],
  linkRules: [
    {
      key: "fixtureLink.twice",
      source: { databaseKey: "linkDupWithinItems", propertyKey: "x" },
      target: { databaseKey: "linkDupWithinItems", propertyKey: "y" },
      via: { databaseKey: "linkDupWithinItems", relationKey: "parent" },
    },
    {
      key: "fixtureLink.twice",
      source: { databaseKey: "linkDupWithinItems", propertyKey: "p" },
      target: { databaseKey: "linkDupWithinItems", propertyKey: "q" },
      via: { databaseKey: "linkDupWithinItems", relationKey: "parent" },
    },
  ],
};
