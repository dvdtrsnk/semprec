import { z } from "zod";
import { ApprovalRequiredError, ForbiddenError, ValidationError } from "@semprec/data";
import type { ModuleManifest } from "@semprec/module-registry";

export const manifest: ModuleManifest = {
  id: "mcpFixture",
  version: "1.0.0",
  name: "MCP fixture",
  removable: true,
  systemProject: false,
  databases: [],
  capabilities: [],
  agentTools: [
    {
      name: "fixture.core",
      handlerExport: "createTool",
      argumentSchemaExport: "args",
      capability: "core.item.read",
      approval: "none",
      riskClass: "read",
    },
    {
      name: "fixture.gated",
      handlerExport: "createTool",
      argumentSchemaExport: "args",
      capability: "core.item.read",
      approval: "always",
      riskClass: "read",
    },
  ],
};
export const args = z
  .object({ fail: z.boolean().optional(), throw: z.enum(["validation", "approval", "domain"]).optional() })
  .strict();
export function createTool() {
  return async (_runId: string, input: { fail?: boolean; throw?: "validation" | "approval" | "domain" }) => {
    if (input.throw === "validation") throw new ValidationError("fixture validation");
    if (input.throw === "approval")
      throw new ApprovalRequiredError("fixture approval", { approvalRequestId: "fixture", link: "/fixture" });
    if (input.throw === "domain") throw new ForbiddenError("fixture domain");
    return { result: input.fail ? "refused" : "ok", error: input.fail === true };
  };
}
