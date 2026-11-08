import type { ModuleManifest } from "../../manifest.js";

/** Reuses the rule key of the A fixture. */
export const manifest: ModuleManifest = {
  id: "fixture-link-duplicate",
  version: "1.0.0",
  name: "Fixture Link Duplicate",
  removable: true,
  systemProject: false,
  databases: [{ key: "linkDuplicateItems", name: "Link Duplicate Items" }],
  capabilities: [],
  agentTools: [],
  linkRules: [
    {
      key: "fixtureLink.aToB",
      source: { databaseKey: "linkDuplicateItems", propertyKey: "x" },
      target: { databaseKey: "linkDuplicateItems", propertyKey: "y" },
      via: { databaseKey: "linkDuplicateItems", relationKey: "parent" },
    },
  ],
};
