import type { ModuleManifest } from "../../manifest.js";
export const manifest: ModuleManifest = {
  id: "noDatabase",
  version: "1",
  name: "No Database",
  removable: true,
  systemProject: false,
  databases: [],
  capabilities: ["empty.read"],
  agentTools: [],
};
