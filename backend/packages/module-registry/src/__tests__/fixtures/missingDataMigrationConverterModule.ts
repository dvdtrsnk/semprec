import type { ModuleManifest } from "../../manifest.js";

export const manifest: ModuleManifest = {
  id: "fixture-missing-data-migration-converter",
  version: "1.0.0",
  name: "Fixture Missing Data Migration Converter",
  removable: true,
  systemProject: false,
  databases: [{ key: "fixtureMissingConverterItems", name: "Fixture Missing Converter Items" }],
  capabilities: [],
  agentTools: [],
  dataMigrations: [
    {
      databaseKey: "fixtureMissingConverterItems",
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      converterExport: "doesNotExist",
    },
  ],
};
