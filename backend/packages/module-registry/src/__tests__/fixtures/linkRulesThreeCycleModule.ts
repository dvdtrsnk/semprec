import type { ModuleManifest } from "../../manifest.js";

export const manifest: ModuleManifest = {
  id: "fixture-link-three-cycle",
  version: "1.0.0",
  name: "Fixture Link Three Cycle",
  removable: true,
  systemProject: false,
  databases: [{ key: "linkThreeCycleItems", name: "Link Three Cycle Items" }],
  capabilities: [],
  agentTools: [],
  linkRules: [
    {
      key: "fixtureLink.threeCycle1",
      source: { databaseKey: "linkThreeCycleItems", propertyKey: "a" },
      target: { databaseKey: "linkThreeCycleItems", propertyKey: "b" },
      via: { databaseKey: "linkThreeCycleItems", relationKey: "parent" },
    },
    {
      key: "fixtureLink.threeCycle2",
      source: { databaseKey: "linkThreeCycleItems", propertyKey: "b" },
      target: { databaseKey: "linkThreeCycleItems", propertyKey: "c" },
      via: { databaseKey: "linkThreeCycleItems", relationKey: "parent" },
    },
    {
      key: "fixtureLink.threeCycle3",
      source: { databaseKey: "linkThreeCycleItems", propertyKey: "c" },
      target: { databaseKey: "linkThreeCycleItems", propertyKey: "a" },
      via: { databaseKey: "linkThreeCycleItems", relationKey: "parent" },
    },
  ],
};
