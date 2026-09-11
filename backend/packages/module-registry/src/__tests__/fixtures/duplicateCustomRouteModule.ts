import type { ModuleManifest } from "../../manifest.js";

export const manifest: ModuleManifest = {
  id: "fixture-duplicate-custom-route",
  version: "1.0.0",
  name: "Fixture Duplicate Custom Route",
  removable: true,
  systemProject: false,
  databases: [],
  capabilities: [],
  agentTools: [],
  customRoutes: [
    {
      name: "fixtureDuplicate.customRoute",
      method: "GET",
      path: "/api/fixture-good/thing",
      handlerExport: "handleCustomRoute",
      justification: "single-consumer-read",
    },
  ],
};

export function handleCustomRoute(): string {
  return "also handled";
}
