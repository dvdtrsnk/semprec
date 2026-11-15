import { z } from "zod";
import type { ModuleManifest } from "../../manifest.js";

export const manifest: ModuleManifest = {
  id: "mcpBadFactory",
  version: "1.0.0",
  name: "MCP Bad Factory",
  removable: true,
  systemProject: false,
  databases: [],
  capabilities: ["mcpBadFactory.read"],
  agentTools: [
    {
      name: "mcpBadFactory.tool",
      handlerExport: "createRunTool",
      argumentSchemaExport: "toolArgsSchema",
      capability: "mcpBadFactory.read",
      approval: "none",
      mcp: { humanHandlerExport: "createBadFactoryTool" },
    },
  ],
};

export const toolArgsSchema = z.object({}).strict();

export function createRunTool() {
  return async () => ({ error: false, result: "unused" });
}

/** A human handler factory that does not return a handler. */
export function createBadFactoryTool() {
  return "not a handler";
}
