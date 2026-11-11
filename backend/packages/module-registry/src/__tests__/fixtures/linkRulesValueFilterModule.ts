import type { ModuleManifest } from "../../manifest.js";

/** One rule with a `valueFilter` whose database (`fixtureSettings`) no module declares, and one rule without a filter. */
export const manifest: ModuleManifest = {
  id: "fixture-link-value-filter",
  version: "1.0.0",
  name: "Fixture Link Value Filter",
  removable: true,
  systemProject: false,
  databases: [{ key: "linkFilterItems", name: "Link Filter Items" }],
  capabilities: [],
  agentTools: [],
  linkRules: [
    {
      key: "fixtureLink.filtered",
      source: { databaseKey: "linkFilterItems", propertyKey: "people" },
      target: { databaseKey: "linkFilterItems", propertyKey: "guests" },
      via: { databaseKey: "linkFilterItems", relationKey: "parent" },
      valueFilter: { omit: { databaseKey: "fixtureSettings", propertyKey: "selfPerson" } },
    },
    {
      key: "fixtureLink.unfiltered",
      source: { databaseKey: "linkFilterItems", propertyKey: "project" },
      target: { databaseKey: "linkFilterItems", propertyKey: "inheritedProject" },
      via: { databaseKey: "linkFilterItems", relationKey: "parent" },
    },
  ],
};
