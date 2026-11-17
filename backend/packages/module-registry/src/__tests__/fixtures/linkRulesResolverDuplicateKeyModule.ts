import type { ModuleManifest } from "../../manifest.js";

export const fixtureResolver = { inputs: { edges: [], properties: [] } };

export const manifest: ModuleManifest = {
  id: "fixture-link-resolver-duplicate",
  version: "1.0.0",
  name: "Fixture Link Resolver Duplicate",
  removable: true,
  systemProject: false,
  databases: [{ key: "linkResolverDuplicateItems", name: "Link Resolver Duplicate Items" }],
  capabilities: [],
  agentTools: [],
  linkRules: [
    {
      key: "fixtureLink.aToB",
      target: { databaseKey: "linkResolverDuplicateItems", propertyKey: "company" },
      resolverExport: "fixtureResolver",
    },
  ],
};
