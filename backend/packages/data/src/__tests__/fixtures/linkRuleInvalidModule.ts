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
      source: { databaseKey: "healthRecords", propertyKey: "nme" },
      target: { databaseKey: "projects", propertyKey: "name" },
      via: { databaseKey: "projects", relationKey: "healthRecords" },
    },
    {
      key: "fixtureInvalid.misspelledVia",
      source: { databaseKey: "healthRecords", propertyKey: "name" },
      target: { databaseKey: "projects", propertyKey: "name" },
      via: { databaseKey: "projects", relationKey: "healthRecordss" },
    },
    {
      key: "fixtureInvalid.viaNotRelation",
      source: { databaseKey: "healthRecords", propertyKey: "name" },
      target: { databaseKey: "projects", propertyKey: "name" },
      via: { databaseKey: "projects", relationKey: "name" },
    },
    {
      key: "fixtureInvalid.wrongDirection",
      source: { databaseKey: "healthRecords", propertyKey: "name" },
      target: { databaseKey: "projects", propertyKey: "name" },
      via: { databaseKey: "healthRecords", relationKey: "files" },
    },
  ],
};
