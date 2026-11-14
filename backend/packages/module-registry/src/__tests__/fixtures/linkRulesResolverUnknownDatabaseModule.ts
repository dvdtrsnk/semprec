import type { ModuleManifest } from "../../manifest.js";

export const fixtureResolver = { inputs: { edges: [], properties: [] } };

export const manifest: ModuleManifest = {
  id: "fixture-link-resolver-unknown-db",
  version: "1.0.0",
  name: "Fixture Link Resolver Unknown Database",
  removable: true,
  systemProject: false,
  databases: [{ key: "linkResolverUnknownItems", name: "Link Resolver Unknown Items" }],
  capabilities: [],
  agentTools: [],
  linkRules: [
    {
      key: "fixtureLink.resolverUnknownDatabase",
      target: { databaseKey: "noSuchDatabase", propertyKey: "company" },
      resolverExport: "fixtureResolver",
    },
  ],
};
