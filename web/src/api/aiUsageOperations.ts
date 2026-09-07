import { z } from "zod";
import { OperationError } from "./genericOperations.js";

/**
 * The client's own binding for `GET /api/ai-usage` (issue #121). Deliberately not folded into
 * `GenericOperations`/`httpGenericOperations.ts`: those mirror the choke-point's item/view
 * surface one to one, and this endpoint isn't a database view — it's a bespoke aggregate read.
 *
 * This client never holds the endpoint's stopgap bearer secret: `Authorization` never appears
 * in browser-reachable code, so the request goes out as a plain same-origin fetch and whatever
 * serves this origin (the dev server's proxy in `vite.config.ts`, later a real reverse proxy or
 * the auth-v1 epic's session) is responsible for attaching or replacing that credential.
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
        response = await fetchImpl(url, { credentials: "same-origin" });
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
