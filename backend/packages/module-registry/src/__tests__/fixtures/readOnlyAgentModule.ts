import type { ModuleManifest } from "../../manifest.js";
export const manifest: ModuleManifest = {
  id: "readOnly",
  version: "1",
  name: "Read Only",
  removable: true,
  systemProject: false,
  databases: [{ key: "inbox", name: "Inbox" }],
  capabilities: ["readonly.read"],
  agentTools: [],
};
