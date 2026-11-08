import type { ModuleManifest } from "../../manifest.js";

export const manifest: ModuleManifest = {
  id: "fixture-link-unknown-db",
  version: "1.0.0",
  name: "Fixture Link Unknown Database",
  removable: true,
  systemProject: false,
  databases: [{ key: "linkUnknownItems", name: "Link Unknown Items" }],
  capabilities: [],
  agentTools: [],
  linkRules: [
    {
      key: "fixtureLink.unknownDatabase",
      source: { databaseKey: "linkUnknownItems", propertyKey: "x" },
      target: { databaseKey: "noSuchDatabase", propertyKey: "y" },
      via: { databaseKey: "linkUnknownItems", relationKey: "parent" },
    },
  ],
};
