import { z } from "zod";
import { OperationError } from "./genericOperations.js";

/**
 * The client's own binding for `GET /api/agent-runs/:id` — the destination the global approval
 * queue's (issue #132) "source agent-run link" points at. Same reasoning as
 * `aiUsageOperations.ts`: not a choke-point view, so not folded into `GenericOperations`.
 *
 * Never carries the endpoint's stopgap bearer secret — same same-origin-fetch reasoning as
 * `aiUsageOperations.ts`.
 */

export const agentRunSchema = z.object({
  id: z.string(),
  projectItemId: z.string().nullable(),
  parentRunId: z.string().nullable(),
  heartbeatId: z.string().nullable(),
  triggeredBy: z.enum(["user", "heartbeat", "supervisor", "mcp"]),
  unit: z.enum(["invocation", "session"]),
  task: z.string(),
  status: z.enum(["running", "done", "error"]),
  result: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});

export type AgentRun = z.infer<typeof agentRunSchema>;

const UNAVAILABLE_STATUSES = new Set([401, 403, 501]);

export interface AgentRunOperationsOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface AgentRunOperations {
  /** `null` for an unknown run id — an ordinary outcome (a stale link, a deleted run), not a failure. */
  getAgentRun(agentRunId: string): Promise<AgentRun | null>;
}

export function createAgentRunOperations(options: AgentRunOperationsOptions): AgentRunOperations {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  return {
    async getAgentRun(agentRunId) {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/agent-runs/${encodeURIComponent(agentRunId)}`, {
          credentials: "same-origin",
        });
      } catch (error) {
        throw new OperationError("retryable", error instanceof Error ? error.message : String(error));
      }

      if (response.status === 404) return null;

      if (!response.ok) {
        throw new OperationError(
          UNAVAILABLE_STATUSES.has(response.status) ? "unavailable" : "retryable",
          `Request to /agent-runs/${agentRunId} failed with ${response.status}`,
          response.status,
        );
      }

      try {
        return agentRunSchema.parse(await response.json());
      } catch (error) {
        throw new OperationError("retryable", error instanceof Error ? error.message : String(error));
      }
    },
  };
}
