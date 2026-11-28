import type { ModuleManifest } from "@alldots/module-registry";

/** Rules over the seeded core databases: Projects.healthRecords is the inverse side of HealthRecords.projects. */
export const manifest: ModuleManifest = {
  id: "fixtureLinkRuleValid",
  version: "1.0.0",
  name: "Fixture Link Rule Valid",
  removable: true,
  systemProject: false,
  databases: [],
  capabilities: [],
  agentTools: [],
  linkRules: [
    {
      key: "fixtureValid.healthRecordNameToProjectName",
      source: { databaseKey: "healthRecords", propertyKey: "name" },
      target: { databaseKey: "projects", propertyKey: "name" },
      via: { databaseKey: "projects", relationKey: "healthRecords" },
    },
  ],
};
