import type { ModuleManifest } from "../../manifest.js";

export const manifest: ModuleManifest = {
  id: "fixture-custom-route-missing-export",
  version: "1.0.0",
  name: "Fixture Custom Route Missing Export",
  removable: true,
  systemProject: false,
  databases: [],
  capabilities: [],
  agentTools: [],
  customRoutes: [
    {
      name: "fixtureMissingExport.thing",
      method: "GET",
      path: "/api/fixture-missing-export/thing",
      handlerExport: "doesNotExist",
      justification: "single-consumer-read",
    },
  ],
};
