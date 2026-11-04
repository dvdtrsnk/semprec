import { z } from "zod";
import type { ModuleManifest } from "../../manifest.js";

export const manifest: ModuleManifest = {
  id: "ownedTools",
  version: "1.0.0",
  name: "Owned Tools",
  removable: true,
  systemProject: false,
  databases: [
    { key: "ownedOne", name: "One" },
    { key: "ownedTwo", name: "Two" },
  ],
  capabilities: ["owned.read"],
  agentTools: [
    {
      name: "owned.inspect",
      handlerExport: "createInspectTool",
      argumentSchemaExport: "inspectArgsSchema",
      capability: "owned.read",
      approval: "none",
      riskClass: "read",
    },
    {
      name: "owned.gated",
      handlerExport: "createInspectTool",
      argumentSchemaExport: "inspectArgsSchema",
      capability: "owned.read",
      approval: "always",
      riskClass: "destructive",
    },
    {
      name: "owned.unknown",
      handlerExport: "createInspectTool",
      argumentSchemaExport: "inspectArgsSchema",
      capability: "unknown.read",
      approval: "none",
      riskClass: "read",
    },
  ],
};
export const inspectArgsSchema = z.object({ value: z.string() }).strict();
export function createInspectTool() {
  return async (_runId: string, args: { value: string }) => {
    if (args.value === "throw") throw new Error("private fixture detail");
    return { error: false, result: args.value };
  };
}
