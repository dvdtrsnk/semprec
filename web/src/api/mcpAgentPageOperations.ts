import { z } from "zod";
import { OperationError } from "./genericOperations.js";

/**
 * The client's own binding for the "Tools" block's HTTP surface (issue #127) — same reasoning
 * as `aiUsageOperations.ts`: this isn't a database view the choke-point's generic item/view
 * surface already covers, it's a bespoke read (registrations joined with server identity and
 * this project's grant) plus two narrow user-only mutations. Deliberately not folded into
 * `GenericOperations`.
 *
 * Never carries the endpoint's stopgap bearer secret — same same-origin-fetch reasoning as
 * `aiUsageOperations.ts`.
 */

export const mcpToolGrantSchema = z.object({
  mcpToolRegistrationId: z.string(),
  toolName: z.string(),
  description: z.string().nullable(),
  requiresApproval: z.boolean(),
  riskClass: z.string(),
  mcpServerItemId: z.string(),
  mcpServerName: z.string(),
  mcpServerOnline: z.boolean(),
  granted: z.boolean(),
});

export type McpToolGrant = z.infer<typeof mcpToolGrantSchema>;

const mcpToolGrantsResponseSchema = z.object({ rows: z.array(mcpToolGrantSchema) });

const projectMcpGrantSchema = z.object({
  projectItemId: z.string(),
  mcpToolRegistrationId: z.string(),
  granted: z.boolean(),
});

const mcpToolRegistrationSchema = z.object({
  id: z.string(),
  mcpServerItemId: z.string(),
  toolName: z.string(),
  description: z.string().nullable(),
  active: z.boolean(),
  requiresApproval: z.boolean(),
  riskClass: z.string(),
});

const UNAVAILABLE_STATUSES = new Set([401, 403, 404, 501]);

export interface McpAgentPageOperationsOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface SetMcpToolGrantInput {
  projectItemId: string;
  mcpToolRegistrationId: string;
  granted: boolean;
}

export interface ReclassifyMcpToolInput {
  mcpToolRegistrationId: string;
  riskClass?: string;
  requiresApproval?: boolean;
}

export interface McpAgentPageOperations {
  listMcpToolGrants(projectItemId: string): Promise<McpToolGrant[]>;
  setMcpToolGrant(input: SetMcpToolGrantInput): Promise<{ granted: boolean }>;
  reclassifyMcpTool(input: ReclassifyMcpToolInput): Promise<{ riskClass: string; requiresApproval: boolean }>;
}

export function createMcpAgentPageOperations(options: McpAgentPageOperationsOptions): McpAgentPageOperations {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  async function request(path: string, init?: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, { credentials: "same-origin", ...init });
    } catch (error) {
      throw new OperationError("retryable", error instanceof Error ? error.message : String(error));
    }

    if (!response.ok) {
      throw new OperationError(
        UNAVAILABLE_STATUSES.has(response.status) ? "unavailable" : "retryable",
        `Request to ${path} failed with ${response.status}`,
        response.status,
      );
    }

    try {
      return await response.json();
    } catch (error) {
      throw new OperationError("retryable", error instanceof Error ? error.message : String(error));
    }
  }

  return {
    async listMcpToolGrants(projectItemId) {
      const body = await request(`/projects/${encodeURIComponent(projectItemId)}/mcp-grants`);
      return mcpToolGrantsResponseSchema.parse(body).rows;
    },

    async setMcpToolGrant(input) {
      const body = await request(`/projects/${encodeURIComponent(input.projectItemId)}/mcp-grants/${encodeURIComponent(input.mcpToolRegistrationId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ granted: input.granted }),
      });
      return projectMcpGrantSchema.parse(body);
    },

    async reclassifyMcpTool(input) {
      const patch: Record<string, unknown> = {};
      if (input.riskClass !== undefined) patch.riskClass = input.riskClass;
      if (input.requiresApproval !== undefined) patch.requiresApproval = input.requiresApproval;
      const body = await request(`/mcp-tool-registrations/${encodeURIComponent(input.mcpToolRegistrationId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      return mcpToolRegistrationSchema.parse(body);
    },
  };
}
