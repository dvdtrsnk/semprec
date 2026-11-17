import type { ModuleManifest } from "../../manifest.js";

export const fixtureResolver = { inputs: { edges: [], properties: [] } };

export const manifest: ModuleManifest = {
  id: "fixture-link-resolver",
  version: "1.0.0",
  name: "Fixture Link Resolver",
  removable: true,
  systemProject: false,
  databases: [{ key: "linkResolverItems", name: "Link Resolver Items" }],
  capabilities: [],
  agentTools: [],
  linkRules: [
    {
      key: "fixtureLink.resolved",
      target: { databaseKey: "linkResolverItems", propertyKey: "company" },
      resolverExport: "fixtureResolver",
    },
    {
      key: "fixtureLink.viaBesideResolver",
      source: { databaseKey: "linkResolverItems", propertyKey: "a" },
      target: { databaseKey: "linkResolverItems", propertyKey: "b" },
      via: { databaseKey: "linkResolverItems", relationKey: "parent" },
    },
  ],
};
