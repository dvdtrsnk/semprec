import { loadModuleCatalogs, resolveCatalogLabel, type ModuleCatalogs } from "@alldots/module-registry";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import type { AgentRunErrorCode } from "./agentRunErrorCodes.js";
import type { AgentRunRow } from "./agentRunsStore.js";
import { fill } from "./catalogFill.js";
import type { IncompleteReplyOutcome } from "./replyOutcome.js";

let catalogsPromise: Promise<ModuleCatalogs> | undefined;

/** Loaded once per process; a failed load is not cached, so the next call retries. */
export function getAgentRunCatalogs(): Promise<ModuleCatalogs> {
  catalogsPromise ??= loadModuleCatalogs(import.meta.url).catch((err: unknown) => {
    catalogsPromise = undefined;
    throw err;
  });
  return catalogsPromise;
}

/**
 * A bare phrase without a trailing period; the surrounding words are the client's. Nothing localized is stored,
 * so a locale change applies to earlier runs too.
 */
export async function agentRunErrorSummary(errorCode: AgentRunErrorCode, locale: string): Promise<string> {
  const catalogs = await getAgentRunCatalogs();
  return resolveCatalogLabel(
    null,
    catalogs[toManifestLocale(locale)],
    catalogs.en,
    `agentRun.error.${errorCode}.summary`,
  );
}

/**
 * A bare phrase without a trailing period. The server name is never declined. A timeout without `timeoutMs` reads
 * as a tool error; a reply without a tool name reads the reason's `.unnamed` entry.
 */
export async function agentRunIncompleteSummary(reply: IncompleteReplyOutcome, locale: string): Promise<string> {
  const catalogs = await getAgentRunCatalogs();
  const reason =
    reply.incompleteReason === "toolTimeout" && reply.timeoutMs === undefined ? "toolError" : reply.incompleteReason;
  const named = reason === "toolTimeout" || reply.connectorName !== undefined;
  const template = resolveCatalogLabel(
    null,
    catalogs[toManifestLocale(locale)],
    catalogs.en,
    named ? `agentRun.incomplete.${reason}` : `agentRun.incomplete.${reason}.unnamed`,
  );
  return fill(template, {
    connector: reply.connectorName ?? "",
    seconds: reply.timeoutMs === undefined ? "" : Number((reply.timeoutMs / 1000).toFixed(1)),
  });
}

export interface AgentRunErrorFields {
  errorCode: AgentRunErrorCode | null;
  errorSummary: string | null;
}

/**
 * Both `null` unless `run.status` is `error`; a `null` code reads as `internal`. The caller passes
 * `incompleteReply` only when the display status is `error` because of it.
 */
export async function agentRunErrorFields(
  run: Pick<AgentRunRow, "status" | "errorCode">,
  locale: string,
  incompleteReply: IncompleteReplyOutcome | null = null,
): Promise<AgentRunErrorFields> {
  if (run.status === "done" && incompleteReply !== null) {
    return { errorCode: null, errorSummary: await agentRunIncompleteSummary(incompleteReply, locale) };
  }
  if (run.status !== "error") return { errorCode: null, errorSummary: null };
  const errorCode = run.errorCode ?? "internal";
  return { errorCode, errorSummary: await agentRunErrorSummary(errorCode, locale) };
}
