import type { ModuleManifest } from "../../manifest.js";

export const manifest: ModuleManifest = {
  id: "fixture-custom-route-duplicate-within-manifest",
  version: "1.0.0",
  name: "Fixture Custom Route Duplicate Within Manifest",
  removable: true,
  systemProject: false,
  databases: [],
  capabilities: [],
  agentTools: [],
  customRoutes: [
    {
      name: "fixtureSelfDupe.first",
      method: "POST",
      path: "/api/fixture-self-dupe/thing",
      handlerExport: "handleFirst",
      justification: "transactional-semantics",
    },
    {
      name: "fixtureSelfDupe.second",
      method: "POST",
      path: "/api/fixture-self-dupe/thing",
      handlerExport: "handleSecond",
      justification: "transactional-semantics",
    },
  ],
};

export function handleFirst(): void {}
export function handleSecond(): void {}
