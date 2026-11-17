import type { ModuleManifest } from "../../manifest.js";
export const manifest: ModuleManifest = {
  id: "invalidToolSchema",
  version: "1",
  name: "Invalid Tool Schema",
  removable: true,
  systemProject: false,
  databases: [],
  capabilities: [],
  agentTools: [
    {
      name: "invalid.schema",
      handlerExport: "handler",
      argumentSchemaExport: "argumentSchema",
      approval: "none",
      riskClass: "read",
    },
  ],
};
export function handler(): void {}
export const argumentSchema = { safeParse: () => ({ success: true }) };
