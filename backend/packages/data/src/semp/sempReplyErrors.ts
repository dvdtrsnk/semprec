import { z } from "zod";
import { loadModuleCatalogs, resolveCatalogLabel, type ModuleCatalogs } from "@semprec/module-registry";
import { AGENT_RUN_ERROR_CODES, agentRunErrorCodeOf, type AgentRunErrorCode } from "../agentRuns/agentRunErrorCodes.js";
import { fill } from "../agentRuns/catalogFill.js";
import { REPLY_INCOMPLETE_REASONS, type ReplyIncompleteReason } from "../agentRuns/replyOutcome.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import type { SempReplyStep } from "./sempReplySteps.js";

/**
 * What is stored next to the `error_code` of a failed Semp reply (`semp_messages.error_params`, issue #1907): ids
 * and counters only, never a user's content and never the text of an exception. `failedStep` is the label of the
 * last step of the reply that failed (an `agentStep.title.*` key with the platform's own params), `connectorName`
 * and `timeoutMs` are those of that step when it was an MCP tool call.
 */
export interface SempReplyErrorParams {
  connectorName?: string;
  failedStep?: { key: string; params: Record<string, string | number> };
  timeoutMs?: number;
}

/** The checked reader of the `error_params` column, which is JSONB and so a boundary. */
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

/** `semp_messages.error_code` as the driver returns it; a failed message that stored no code (a legacy row) reads `internal`. */
export function parseSempReplyErrorCode(value: unknown): AgentRunErrorCode {
  if (value === null || value === undefined) return "internal";
  const code = AGENT_RUN_ERROR_CODES.find((known) => known === value);
  if (code === undefined) throw new Error("Malformed semp_messages.error_code in database row");
  return code;
}

/**
 * The error of a failed Semp turn: the code and params stored on its message. The code is the one the run was
 * closed with (`agentRunErrorCodeOf`: `budgetExceeded` from the typed budget refusal, `modelError` from a model
 * stop reason `error`, `cancelled`, anything else `internal`), never derived from the text of the error. An abort
 * by the user or a tenant deactivation is `cancelled` however the abort surfaced; an abort of the shutdown
 * (`signal.reason` `shutdown`) is `interrupted`. A turn that failed with an `AggregateError` whose `cause` is the
 * turn's own error (the turn error kept next to a cleanup failure) is classified by that cause.
 *
 * `steps` is the summary of the turn up to the failure, if it could be read. Nothing of `error` itself is stored:
 * not its message, and not its properties.
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

/** The Semp catalogs (`semp/i18n`), loaded once per process; a failed load is not cached. */
function getSempCatalogs(): Promise<ModuleCatalogs> {
  catalogsPromise ??= loadModuleCatalogs(import.meta.url).catch((error: unknown) => {
    catalogsPromise = undefined;
    throw error;
  });
  return catalogsPromise;
}

/**
 * The text of a reply failure, in `locale` (a `users.locale`; any locale but `cs` reads the English entry), from
 * the `reply.failure.*` entries of the Semp catalog. It is rendered on every read and nothing localized is stored,
 * so a locale change applies to replies that failed earlier too.
 *
 * The text of a run error code is the same whatever `params` hold. The text of an incomplete reason names the
 * connector (`params.connectorName`, else a generic word) and a timeout names its seconds (`params.timeoutMs`,
 * to a tenth of a second); a timeout with no stored `timeoutMs` reads as a tool error.
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
