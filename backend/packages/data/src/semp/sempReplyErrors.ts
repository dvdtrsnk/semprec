import { z } from "zod";
import { loadModuleCatalogs, resolveCatalogLabel, type ModuleCatalogs } from "@semprec/module-registry";
import { AGENT_RUN_ERROR_CODES, agentRunErrorCodeOf, type AgentRunErrorCode } from "../agentRuns/agentRunErrorCodes.js";
import { fill } from "../agentRuns/catalogFill.js";
import { REPLY_INCOMPLETE_REASONS, type ReplyIncompleteReason } from "../agentRuns/replyOutcome.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import type { SempReplyStep } from "./sempReplySteps.js";

/**
 * `semp_messages.error_params`: ids and counters only, never user content or exception text. `failedStep` is the
 * label of the last failed step; `connectorName` and `timeoutMs` are set when that step was an MCP tool call.
 */
export interface SempReplyErrorParams {
  connectorName?: string;
  failedStep?: { key: string; params: Record<string, string | number> };
  timeoutMs?: number;
}

/** JSONB column, so it is checked as a boundary. */
const sempReplyErrorParamsSchema = z.strictObject({
  connectorName: z.string().optional(),
  failedStep: z
    .strictObject({ key: z.string(), params: z.record(z.string(), z.union([z.string(), z.number()])) })
    .optional(),
  timeoutMs: z.number().int().nonnegative().optional(),
});

/** `semp_messages.error_params` as the driver returns it; a malformed value throws. */
export function parseSempReplyErrorParams(value: unknown): SempReplyErrorParams {
  if (value === null || value === undefined) return {};
  const parsed = sempReplyErrorParamsSchema.safeParse(value);
  if (!parsed.success) throw new Error("Malformed semp_messages.error_params in database row");
  return parsed.data;
}

/** A failed legacy row with no stored code reads `internal`. */
export function parseSempReplyErrorCode(value: unknown): AgentRunErrorCode {
  if (value === null || value === undefined) return "internal";
  const code = AGENT_RUN_ERROR_CODES.find((known) => known === value);
  if (code === undefined) throw new Error("Malformed semp_messages.error_code in database row");
  return code;
}

/**
 * The code is the one the run was closed with (`agentRunErrorCodeOf`), never derived from the error text. A user
 * abort or tenant deactivation is `cancelled`; a shutdown abort is `interrupted`. An `AggregateError` whose
 * `cause` is the turn's own error (kept next to a cleanup failure) is classified by that cause.
 *
 * Nothing of `error` itself is stored.
 */
export function classifySempTurnFailure(input: {
  error: unknown;
  signal: Pick<AbortSignal, "aborted" | "reason">;
  steps: readonly SempReplyStep[];
}): { errorCode: AgentRunErrorCode; errorParams: SempReplyErrorParams } {
  const { error, signal, steps } = input;
  const turnError = error instanceof AggregateError && error.cause !== undefined ? error.cause : error;
  let errorCode: AgentRunErrorCode;
  if (signal.aborted) errorCode = signal.reason === "shutdown" ? "interrupted" : "cancelled";
  else errorCode = agentRunErrorCodeOf(turnError);
  const failed = [...steps].reverse().find((step) => step.status === "error");
  if (failed === undefined) return { errorCode, errorParams: {} };
  const params: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(failed.label.params)) {
    if (typeof value === "string" || typeof value === "number") params[name] = value;
  }
  return {
    errorCode,
    errorParams: {
      failedStep: { key: failed.label.key, params },
      ...(failed.connectorName !== undefined ? { connectorName: failed.connectorName } : {}),
      ...(failed.timeoutMs !== undefined ? { timeoutMs: failed.timeoutMs } : {}),
    },
  };
}

/** The codes `renderSempReplyFailure` has a text for: the run error codes and the reasons a reply is incomplete. */
export type SempReplyFailureCode = AgentRunErrorCode | ReplyIncompleteReason;

let catalogsPromise: Promise<ModuleCatalogs> | undefined;

/** Loaded once per process; a failed load is not cached. */
function getSempCatalogs(): Promise<ModuleCatalogs> {
  catalogsPromise ??= loadModuleCatalogs(import.meta.url).catch((error: unknown) => {
    catalogsPromise = undefined;
    throw error;
  });
  return catalogsPromise;
}

/**
 * Rendered on every read in `locale` (any but `cs` reads English), so a locale change applies to old failures.
 * Incomplete reasons name the connector (or a generic word) and a timeout its seconds to a tenth; a timeout
 * without `timeoutMs` reads as a tool error.
 */
export async function renderSempReplyFailure(
  code: SempReplyFailureCode,
  params: SempReplyErrorParams,
  locale: string,
): Promise<string> {
  const catalogs = await getSempCatalogs();
  const own = catalogs[toManifestLocale(locale)];
  const lookup = (key: string) => resolveCatalogLabel(null, own, catalogs.en, key);
  const reason = code === "toolTimeout" && params.timeoutMs === undefined ? "toolError" : code;
  if (!(REPLY_INCOMPLETE_REASONS as readonly string[]).includes(reason)) return lookup(`reply.failure.${reason}`);
  return fill(lookup(`reply.failure.${reason}`), {
    connector: params.connectorName ?? lookup("reply.failure.unnamedConnector"),
    seconds: params.timeoutMs === undefined ? "" : Number((params.timeoutMs / 1000).toFixed(1)),
  });
}
