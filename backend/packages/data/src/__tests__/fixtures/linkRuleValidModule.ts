import type { ModuleManifest } from "@semprec/module-registry";

/** Rules over the seeded ten databases: Projects.area is the inverse side of Areas.projects. */
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
      key: "fixtureValid.areaNameToProjectName",
      source: { databaseKey: "areas", propertyKey: "name" },
      target: { databaseKey: "projects", propertyKey: "name" },
      via: { databaseKey: "projects", relationKey: "area" },
    },
  ],
};
