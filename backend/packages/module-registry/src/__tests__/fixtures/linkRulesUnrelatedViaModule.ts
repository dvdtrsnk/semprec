import type { ModuleManifest } from "../../manifest.js";

export const manifest: ModuleManifest = {
  id: "fixture-link-unrelated-via",
  version: "1.0.0",
  name: "Fixture Link Unrelated Via",
  removable: true,
  systemProject: false,
  databases: [
    { key: "linkViaOne", name: "Link Via One" },
    { key: "linkViaTwo", name: "Link Via Two" },
    { key: "linkViaThree", name: "Link Via Three" },
  ],
  capabilities: [],
  agentTools: [],
  linkRules: [
    {
      key: "fixtureLink.unrelatedVia",
      source: { databaseKey: "linkViaOne", propertyKey: "x" },
      target: { databaseKey: "linkViaTwo", propertyKey: "y" },
      via: { databaseKey: "linkViaThree", relationKey: "parent" },
    },
  ],
};
