import { z } from "zod";
import type { ModuleManifest } from "../../manifest.js";

export const manifest: ModuleManifest = {
  id: "mcpTools",
  version: "1.0.0",
  name: "MCP Tools",
  removable: true,
  systemProject: false,
  databases: [],
  capabilities: ["mcpTools.read"],
  agentTools: [
    {
      name: "mcpTools.exposed",
      handlerExport: "createRunTool",
      argumentSchemaExport: "toolArgsSchema",
      capability: "mcpTools.read",
      approval: "none",
      riskClass: "read",
      mcp: { humanHandlerExport: "createHumanTool" },
    },
    {
      name: "mcpTools.sessionOnly",
      handlerExport: "createRunTool",
      argumentSchemaExport: "toolArgsSchema",
      capability: "mcpTools.read",
      approval: "none",
      riskClass: "read",
    },
    {
      name: "mcpTools.badResult",
      handlerExport: "createRunTool",
      argumentSchemaExport: "toolArgsSchema",
      capability: "mcpTools.read",
      approval: "none",
      mcp: { humanHandlerExport: "createBadResultTool" },
    },
    // A gated tool that opts in to MCP: a human session runs it as the user, a run credential defers it.
    {
      name: "mcpTools.gatedExposed",
      handlerExport: "createRunTool",
      argumentSchemaExport: "toolArgsSchema",
      capability: "mcpTools.read",
      approval: "always",
      riskClass: "write",
      requiresApproval: true,
      mcp: { humanHandlerExport: "createHumanTool" },
    },
    // A gated tool that does not: a human session never sees it.
    {
      name: "mcpTools.gatedSessionOnly",
      handlerExport: "createRunTool",
      argumentSchemaExport: "toolArgsSchema",
      capability: "mcpTools.read",
      approval: "always",
      riskClass: "write",
      requiresApproval: true,
    },
  ],
};

export const toolArgsSchema = z.object({ value: z.string().optional() }).strict();

export function createRunTool() {
  return async () => ({ error: false, result: "run" });
}

/** The human handler: answers who called it, with what, and the dependencies its factory was built with. */
export function createHumanTool(_pool: unknown, dependencies: unknown) {
  return async (userId: string, args: unknown) => ({
    error: false,
    result: JSON.stringify({ userId, args, dependencies }),
  });
}

/** A human handler whose answer lacks the `result` text every handler promises. */
export function createBadResultTool() {
  return async () => ({ error: false });
}
