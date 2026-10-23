import type { ModuleManifest } from "../../manifest.js";

export const manifest: ModuleManifest = {
  id: "fixture-duplicate-data-migration",
  version: "1.0.0",
  name: "Fixture Duplicate Data Migration",
  removable: true,
  systemProject: false,
  databases: [{ key: "fixtureDupItems", name: "Fixture Dup Items" }],
  capabilities: [],
  agentTools: [],
  dataMigrations: [
    { databaseKey: "fixtureDupItems", fromVersion: "1.0.0", toVersion: "2.0.0", converterExport: "convertItem" },
    { databaseKey: "fixtureDupItems", fromVersion: "1.0.0", toVersion: "2.0.0", converterExport: "convertItem" },
  ],
};

export function convertItem(properties: Record<string, unknown>): Record<string, unknown> {
  return properties;
}
