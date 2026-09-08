import { z } from "zod";
import { OperationError } from "./genericOperations.js";

/**
 * The client's own binding for the global approval queue (issue #132):
 * `GET /api/approval-requests` (issue #132) and `PATCH /api/approval-requests/:id`
 * (issue #131). Same reasoning as `aiUsageOperations.ts`/`mcpAgentPageOperations.ts`: this
 * isn't a database view the choke-point's generic item/view surface covers, it's a bespoke
 * cross-project read plus a narrow decision write. Deliberately not folded into
 * `GenericOperations`.
 *
 * Never carries the endpoint's stopgap bearer secret — same same-origin-fetch reasoning as
 * `aiUsageOperations.ts`.
 */

const approvalRequestRowSchema = z.object({
  id: z.string(),
  toolName: z.string(),
  riskClass: z.string(),
  requestedAt: z.string(),
  safeSummary: z.object({
    mcpToolRegistrationId: z.string(),
    mcpServerItemId: z.string(),
    argKeys: z.array(z.string()),
  }),
  agentRunId: z.string(),
  projectItemId: z.string().nullable(),
  projectName: z.string().nullable(),
});

export type ApprovalRequestRow = z.infer<typeof approvalRequestRowSchema>;

/** Whatever shape the id came in as, kept around so a malformed row can still be identified in the UI without re-parsing the rest of it. */
const rawApprovalRequestRowSchema = z.object({ id: z.unknown() }).passthrough();

/**
 * A queue entry that failed to validate against `approvalRequestRowSchema` — a schema drift
 * or a corrupted stored payload. Carries the row through anyway (as `raw`) instead of
 * discarding the whole list, so one bad row degrades to a "malformed" placeholder for that
 * row alone rather than an error state for the entire queue.
 */
export interface MalformedApprovalRequestRow {
  id: string | null;
  raw: unknown;
}

export type ApprovalQueueEntry =
  | { kind: "ok"; row: ApprovalRequestRow }
  | { kind: "malformed"; row: MalformedApprovalRequestRow };

function parseQueueRow(raw: unknown): ApprovalQueueEntry {
  const parsed = approvalRequestRowSchema.safeParse(raw);
  if (parsed.success) return { kind: "ok", row: parsed.data };

  const rawRow = rawApprovalRequestRowSchema.safeParse(raw);
  const id = rawRow.success && typeof rawRow.data.id === "string" ? rawRow.data.id : null;
  return { kind: "malformed", row: { id, raw } };
}

export type ApprovalDecision = "approved" | "rejected";

const decidedApprovalRequestSchema = z.object({
  id: z.string(),
  status: z.enum(["pending", "approved", "rejected"]),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
});

export type DecidedApprovalRequest = z.infer<typeof decidedApprovalRequestSchema>;

const UNAVAILABLE_STATUSES = new Set([401, 403, 404, 501]);

export interface ApprovalQueueOperationsOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface DecideApprovalRequestInput {
  approvalRequestId: string;
  decision: ApprovalDecision;
  decidedByUserId: string;
}

export interface ApprovalQueueOperations {
  listApprovalRequests(): Promise<ApprovalQueueEntry[]>;
  decideApprovalRequest(input: DecideApprovalRequestInput): Promise<DecidedApprovalRequest>;
}

export function createApprovalQueueOperations(options: ApprovalQueueOperationsOptions): ApprovalQueueOperations {
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
    async listApprovalRequests() {
      const body = (await request("/approval-requests")) as { rows?: unknown[] };
      return (body.rows ?? []).map(parseQueueRow);
    },

    async decideApprovalRequest(input) {
      const body = await request(`/approval-requests/${encodeURIComponent(input.approvalRequestId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: input.decision, decidedByUserId: input.decidedByUserId }),
      });
      return decidedApprovalRequestSchema.parse(body);
    },
  };
}
