import type { ModuleManifest } from "../../manifest.js";

export const manifest: ModuleManifest = {
  id: "fixture-unknown-database-key-data-migration",
  version: "1.0.0",
  name: "Fixture Unknown Database Key Data Migration",
  removable: true,
  systemProject: false,
  databases: [{ key: "fixtureUnknownKeyItems", name: "Fixture Unknown Key Items" }],
  capabilities: [],
  agentTools: [],
  dataMigrations: [
    { databaseKey: "notMyDatabase", fromVersion: "1.0.0", toVersion: "2.0.0", converterExport: "convertItem" },
  ],
};

export function convertItem(properties: Record<string, unknown>): Record<string, unknown> {
  return properties;
}
