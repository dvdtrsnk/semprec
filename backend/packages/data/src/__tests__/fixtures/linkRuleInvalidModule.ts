import type { ModuleManifest } from "@semprec/module-registry";

export const manifest: ModuleManifest = {
  id: "fixtureLinkRuleInvalid",
  version: "1.0.0",
  name: "Fixture Link Rule Invalid",
  removable: true,
  systemProject: false,
  databases: [],
  capabilities: [],
  agentTools: [],
  linkRules: [
    {
      key: "fixtureInvalid.misspelledSource",
      source: { databaseKey: "areas", propertyKey: "nme" },
      target: { databaseKey: "projects", propertyKey: "name" },
      via: { databaseKey: "projects", relationKey: "area" },
    },
    {
      key: "fixtureInvalid.misspelledVia",
      source: { databaseKey: "areas", propertyKey: "name" },
      target: { databaseKey: "projects", propertyKey: "name" },
      via: { databaseKey: "projects", relationKey: "areaa" },
    },
    {
      key: "fixtureInvalid.viaNotRelation",
      source: { databaseKey: "areas", propertyKey: "name" },
      target: { databaseKey: "projects", propertyKey: "name" },
      via: { databaseKey: "projects", relationKey: "name" },
    },
    {
      key: "fixtureInvalid.wrongDirection",
      source: { databaseKey: "areas", propertyKey: "name" },
      target: { databaseKey: "projects", propertyKey: "name" },
      via: { databaseKey: "areas", relationKey: "company" },
    },
  ],
};
