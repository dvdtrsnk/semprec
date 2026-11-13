import { loadModuleCatalogs, resolveCatalogLabel, type ModuleCatalogs } from "@semprec/module-registry";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import type { AgentRunErrorCode } from "./agentRunErrorCodes.js";
import type { AgentRunRow } from "./agentRunsStore.js";
import { fill } from "./catalogFill.js";
import type { IncompleteReplyOutcome } from "./replyOutcome.js";

let catalogsPromise: Promise<ModuleCatalogs> | undefined;

/**
 * Lazily loaded once per process and reused: `agentRuns/i18n/{cs,en}.json` never changes at runtime.
 * A failed load is not kept, so the next call tries again. The step catalog (`agentStepCatalog.ts`)
 * reads the same files through it.
 */
export function getAgentRunCatalogs(): Promise<ModuleCatalogs> {
  catalogsPromise ??= loadModuleCatalogs(import.meta.url).catch((err: unknown) => {
    catalogsPromise = undefined;
    throw err;
  });
  return catalogsPromise;
}

/**
 * The short reason a run failed with `errorCode`, in `locale` (a `users.locale`; any locale but `cs`
 * reads the English entry), as a bare phrase without a trailing period (issue #1824). The prefix
 * words around it ("failed - ") are the client's. This is the one place that turns a code into text:
 * nothing localized is ever stored, so a locale change applies to runs closed earlier too.
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
 * The short reason a run whose reply is incomplete (issue #1890) gives, in `locale`, as a bare phrase without a
 * trailing period: "{connector} unavailable", "connection timed out ({seconds} s)" or "tool {connector}
 * returned an error". The server's name stands in the nominative and is never declined; the seconds are the
 * stored `timeoutMs`, shown to a tenth of a second at most. A timeout that stored no `timeoutMs` has no
 * seconds to name and reads as a tool error. A reply that recorded no name (a failed step whose tool name
 * the step could not store) has no `{connector}` to fill, so it reads the `.unnamed` entry of its reason
 * ("tool unavailable", "a tool returned an error") instead of a placeholder glyph.
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

/** The failure of a run as a client reads it (issue #1824). */
export interface AgentRunErrorFields {
  errorCode: AgentRunErrorCode | null;
  errorSummary: string | null;
}

/**
 * `{ errorCode, errorSummary }` of `run` in `locale`: both `null` unless `run.status` is `error`.
 * A failed run whose code is `null` reads as `internal`, and a run closed with an error code keeps the
 * summary of that code. A run that finished as `done` whose reply is incomplete (`incompleteReply`, issue
 * #1890) has no code but the summary of the incomplete reply; the caller passes the reply only when the run's
 * display status reads `error` because of it.
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
