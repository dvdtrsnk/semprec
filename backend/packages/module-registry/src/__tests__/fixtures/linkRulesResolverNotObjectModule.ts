import type { ModuleManifest } from "../../manifest.js";

export const notAnObject = (): number => 1;

export const manifest: ModuleManifest = {
  id: "fixture-link-resolver-not-object",
  version: "1.0.0",
  name: "Fixture Link Resolver Not Object",
  removable: true,
  systemProject: false,
  databases: [{ key: "linkResolverNotObjectItems", name: "Link Resolver Not Object Items" }],
  capabilities: [],
  agentTools: [],
  linkRules: [
    {
      key: "fixtureLink.resolverNotObject",
      target: { databaseKey: "linkResolverNotObjectItems", propertyKey: "company" },
      resolverExport: "notAnObject",
    },
  ],
};
