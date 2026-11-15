import { z } from "zod";
import type { ModuleManifest } from "../../manifest.js";

export const manifest: ModuleManifest = {
  id: "mcpMissingHumanHandler",
  version: "1.0.0",
  name: "MCP Missing Human Handler",
  removable: true,
  systemProject: false,
  databases: [],
  capabilities: ["mcpMissing.read"],
  agentTools: [
    {
      name: "mcpMissing.tool",
      handlerExport: "createRunTool",
      argumentSchemaExport: "toolArgsSchema",
      capability: "mcpMissing.read",
      approval: "none",
      mcp: { humanHandlerExport: "doesNotExist" },
    },
  ],
};

export const toolArgsSchema = z.object({}).strict();

export function createRunTool() {
  return async () => ({ error: false, result: "unused" });
}
