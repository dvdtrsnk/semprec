import { loadModuleCatalogs, resolveCatalogLabel, type ModuleCatalogs } from "@semprec/module-registry";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import type { AgentRunErrorCode } from "./agentRunErrorCodes.js";
import type { AgentRunRow } from "./agentRunsStore.js";

let catalogsPromise: Promise<ModuleCatalogs> | undefined;

/**
 * Lazily loaded once per process and reused: `agentRuns/i18n/{cs,en}.json` never changes at runtime.
 * A failed load is not kept, so the next call tries again.
 */
function getAgentRunErrorCatalogs(): Promise<ModuleCatalogs> {
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
  const catalogs = await getAgentRunErrorCatalogs();
  return resolveCatalogLabel(
    null,
    catalogs[toManifestLocale(locale)],
    catalogs.en,
    `agentRun.error.${errorCode}.summary`,
  );
}

/** The failure of a run as a client reads it (issue #1824). */
export interface AgentRunErrorFields {
  errorCode: AgentRunErrorCode | null;
  errorSummary: string | null;
}

/**
 * `{ errorCode, errorSummary }` of `run` in `locale`: both `null` unless `run.status` is `error`.
 * A failed run whose code is `null` reads as `internal`.
 */
export async function agentRunErrorFields(
  run: Pick<AgentRunRow, "status" | "errorCode">,
  locale: string,
): Promise<AgentRunErrorFields> {
  if (run.status !== "error") return { errorCode: null, errorSummary: null };
  const errorCode = run.errorCode ?? "internal";
  return { errorCode, errorSummary: await agentRunErrorSummary(errorCode, locale) };
}
