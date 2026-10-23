import { z } from "zod";
import { OperationError } from "./genericOperations.js";

/**
 * The client's own binding for `GET /api/system-health` (issue #170). Deliberately not folded
 * into `GenericOperations`/`httpGenericOperations.ts`, for the same reason `aiUsageOperations.ts`
 * isn't: this is a bespoke aggregate read outside the item/view model, not a database view.
 *
 * This client never holds a bearer secret: the request goes out as a plain same-origin fetch,
 * and whatever serves this origin (the dev server's proxy in `vite.config.ts`, later a real
 * reverse proxy or the auth-v1 epic's session) is responsible for attaching or replacing any
 * credential.
 */

export const processHealthStatusSchema = z.object({
  process: z.string(),
  present: z.boolean(),
  stale: z.boolean(),
  pid: z.number().nullable(),
  version: z.string().nullable(),
  startedAt: z.string().nullable(),
  beatAt: z.string().nullable(),
  uptimeMs: z.number().nullable(),
});

export type ProcessHealthStatus = z.infer<typeof processHealthStatusSchema>;

export const alertingCheckSchema = z.object({
  checkKey: z.string(),
  detail: z.record(z.string(), z.unknown()),
  changedAt: z.string(),
});

export type AlertingCheck = z.infer<typeof alertingCheckSchema>;

export const queueHealthCountsSchema = z.object({
  pending: z.number(),
  overdue: z.number(),
  permanent: z.number(),
});

export type QueueHealthCounts = z.infer<typeof queueHealthCountsSchema>;

export const itemAutomationErrorCountSchema = z.object({
  databaseId: z.string(),
  errorCount: z.number(),
});

export type ItemAutomationErrorCount = z.infer<typeof itemAutomationErrorCountSchema>;

export const mailboxHealthStatusSchema = z.object({
  mailboxItemId: z.string(),
  lastActivityAt: z.string().nullable(),
  lastError: z.string().nullable(),
  nextExpectedActivityAt: z.string().nullable(),
});

export type MailboxHealthStatus = z.infer<typeof mailboxHealthStatusSchema>;

export const systemHealthReportSchema = z.object({
  generatedAt: z.string(),
  processes: z.array(processHealthStatusSchema),
  alertingChecks: z.array(alertingCheckSchema),
  queue: queueHealthCountsSchema,
  itemAutomationErrorsByDatabase: z.array(itemAutomationErrorCountSchema),
  agentRunErrors7d: z.number(),
  mailboxes: z.array(mailboxHealthStatusSchema),
});

export type SystemHealthReport = z.infer<typeof systemHealthReportSchema>;

const UNAVAILABLE_STATUSES = new Set([401, 403, 404, 501]);

export interface SystemHealthOperationsOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export interface SystemHealthOperations {
  getSystemHealthReport(): Promise<SystemHealthReport>;
}

export function createSystemHealthOperations(options: SystemHealthOperationsOptions): SystemHealthOperations {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  return {
    async getSystemHealthReport() {
      const url = `${baseUrl}/system-health`;
      let response: Response;
      try {
        response = await fetchImpl(url, { credentials: "same-origin" });
      } catch (error) {
        throw new OperationError("retryable", error instanceof Error ? error.message : String(error));
      }

      if (!response.ok) {
        throw new OperationError(
          UNAVAILABLE_STATUSES.has(response.status) ? "unavailable" : "retryable",
          `Request to /system-health failed with ${response.status}`,
          response.status,
        );
      }

      try {
        return systemHealthReportSchema.parse(await response.json());
      } catch (error) {
        throw new OperationError("retryable", error instanceof Error ? error.message : String(error));
      }
    },
  };
}
