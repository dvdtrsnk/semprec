import type { ModuleManifest } from "../../manifest.js";

export const manifest: ModuleManifest = {
  id: "fixture-link-resolver-missing",
  version: "1.0.0",
  name: "Fixture Link Resolver Missing",
  removable: true,
  systemProject: false,
  databases: [{ key: "linkResolverMissingItems", name: "Link Resolver Missing Items" }],
  capabilities: [],
  agentTools: [],
  linkRules: [
    {
      key: "fixtureLink.resolverMissing",
      target: { databaseKey: "linkResolverMissingItems", propertyKey: "company" },
      resolverExport: "noSuchResolver",
    },
  ],
};
