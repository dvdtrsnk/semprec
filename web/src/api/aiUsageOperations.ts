import { z } from "zod";
import { OperationError } from "./genericOperations.js";

/**
 * The client's own binding for `GET /api/ai-usage` (issue #121). Deliberately not folded into
 * `GenericOperations`/`httpGenericOperations.ts`: those mirror the choke-point's item/view
 * surface one to one, and this endpoint isn't a database view — it's a bespoke aggregate read
 * with its own auth (a stopgap bearer token ahead of the auth-v1 epic, #138-143).
 */

export const aiUsageRowSchema = z.object({
  provider: z.string(),
  model: z.string(),
  nativeUnit: z.enum(["tokens", "audio_seconds"]),
  runUnit: z.enum(["invocation", "session"]).nullable(),
  callCount: z.number(),
  costUsd: z.number(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  audioSeconds: z.number().nullable(),
});

export type AiUsageRow = z.infer<typeof aiUsageRowSchema>;

export const dailyCostPointSchema = z.object({ day: z.string(), costUsd: z.number() });

export type DailyCostPoint = z.infer<typeof dailyCostPointSchema>;

export const aiUsageReportSchema = z.object({
  from: z.string(),
  to: z.string(),
  rows: z.array(aiUsageRowSchema),
  totalCostUsd: z.number(),
  dailyCostUsd: z.array(dailyCostPointSchema),
  budgets: z.object({
    dailyBudgetUsd: z.number().nullable(),
    monthlyBudgetUsd: z.number().nullable(),
  }),
});

export type AiUsageReport = z.infer<typeof aiUsageReportSchema>;

const UNAVAILABLE_STATUSES = new Set([401, 403, 404, 501]);

export interface AiUsageOperationsOptions {
  baseUrl: string;
  /** The stopgap shared-secret bearer token this endpoint expects (see aiUsageHandler.ts). */
  authToken: string;
  fetchImpl?: typeof fetch;
}

export interface AiUsageOperations {
  getAiUsageReport(from: string, to: string): Promise<AiUsageReport>;
}

export function createAiUsageOperations(options: AiUsageOperationsOptions): AiUsageOperations {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  return {
    async getAiUsageReport(from, to) {
      const url = `${baseUrl}/ai-usage?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      let response: Response;
      try {
        response = await fetchImpl(url, {
          headers: { Authorization: `Bearer ${options.authToken}` },
          credentials: "same-origin",
        });
      } catch (error) {
        throw new OperationError("retryable", error instanceof Error ? error.message : String(error));
      }

      if (!response.ok) {
        throw new OperationError(
          UNAVAILABLE_STATUSES.has(response.status) ? "unavailable" : "retryable",
          `Request to /ai-usage failed with ${response.status}`,
          response.status,
        );
      }

      try {
        return aiUsageReportSchema.parse(await response.json());
      } catch (error) {
        throw new OperationError("retryable", error instanceof Error ? error.message : String(error));
      }
    },
  };
}
