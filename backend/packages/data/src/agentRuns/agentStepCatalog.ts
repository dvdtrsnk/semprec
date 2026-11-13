import type { ModuleCatalog } from "@semprec/module-registry";
import type { GenericOperationName } from "@semprec/shared";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import { getAgentRunCatalogs } from "./agentRunErrorSummary.js";
import { fill } from "./catalogFill.js";

/**
 * The step catalog (issue #1847): the localized title and summary of a step of an agent run. It is the one
 * place that turns a tool call into text, so the per-reply step summary (issue #1860) reads the same
 * entries. The texts are the `agentStep.*` keys of `agentRuns/i18n/{cs,en}.json`, keyed by English
 * canonical keys; nothing localized is stored, so a locale change applies to runs recorded earlier too.
 */

/**
 * The tool a step called: a generic operation, an MCP tool, a tool stored without identity (a row from
 * before issue #1424) that is known by its model-facing name, or a tool with none of these.
 */
export type AgentStepTool =
  | { kind: "operation"; operation: GenericOperationName }
  | { kind: "mcp"; toolName: string }
  | { kind: "named"; toolName: string }
  | { kind: "unknown" };

/** The kinds of step whose title does not depend on a tool. */
export type AgentStepPlainKind = "start" | "plan" | "answer" | "end" | "error";

/** What a tool step's summary is made of: structured facts only, never a result text. */
export type AgentStepSummaryInput =
  | { kind: "end"; toolCount: number; approvalCount: number }
  | {
      kind: "tool";
      state: "running" | "ok" | "error";
      operation: GenericOperationName | null;
      /** The call created an approval request. */
      approval: boolean;
      /** How many properties an `item.patch` reported as changed. */
      changeCount: number;
    };

interface Catalogs {
  locale: ModuleCatalog;
  en: ModuleCatalog;
}

async function loadCatalogs(locale: string): Promise<Catalogs> {
  const catalogs = await getAgentRunCatalogs();
  return { locale: catalogs[toManifestLocale(locale)], en: catalogs.en };
}

/** The entry for `key` in the locale's catalog, else in the English one, else `undefined`. */
function lookup(catalogs: Catalogs, key: string): string | undefined {
  return catalogs.locale[key] ?? catalogs.en[key];
}

/**
 * The plural form of `base` for `count`: `${base}.zero` for 0 when the catalog has it, else the entry of
 * the locale's plural category (`one`, `few`, ...), else `${base}.other`. The missing-entry case ends in
 * `.other`, which every plural group has.
 */
function pluralText(catalogs: Catalogs, locale: string, base: string, count: number): string {
  const category = new Intl.PluralRules(toManifestLocale(locale)).select(count);
  const text =
    (count === 0 ? lookup(catalogs, `${base}.zero`) : undefined) ??
    lookup(catalogs, `${base}.${category}`) ??
    lookup(catalogs, `${base}.other`) ??
    `${base}.other`;
  return fill(text, { count });
}

function targetNoun(catalogs: Catalogs, moduleId: string | null, form: "one" | "many"): string {
  const own = moduleId === null ? undefined : lookup(catalogs, `agentStep.target.${moduleId}.${form}`);
  return own ?? lookup(catalogs, `agentStep.target.generic.${form}`) ?? `agentStep.target.generic.${form}`;
}

/** The title of a step that is not a tool step. */
export async function stepKindTitle(locale: string, kind: AgentStepPlainKind): Promise<string> {
  const catalogs = await loadCatalogs(locale);
  const key = `agentStep.title.${kind}`;
  return lookup(catalogs, key) ?? key;
}

/**
 * The title of a tool step in `locale` (a `users.locale`; any locale but `cs` reads the English entry).
 * A generic operation reads its own entry, with the target database's noun (`targetDatabaseModuleId`, the
 * `owner_module_id` of the database the call worked in) filled in: `database.query` over the tasks gives
 * "Searching tasks", `item.patch` "Changing a task". A database without a known module id reads the
 * generic noun. An MCP tool and a tool stored without identity are named; an operation without an
 * entry reads the generic "Using a tool".
 */
export async function stepTitle(
  locale: string,
  tool: AgentStepTool,
  targetDatabaseModuleId: string | null,
): Promise<string> {
  const catalogs = await loadCatalogs(locale);
  const generic = lookup(catalogs, "agentStep.title.tool") ?? "agentStep.title.tool";
  if (tool.kind === "unknown") return generic;
  if (tool.kind !== "operation") {
    const named = lookup(catalogs, "agentStep.title.namedTool");
    return named === undefined ? generic : fill(named, { toolName: tool.toolName });
  }
  const template = lookup(catalogs, `agentStep.title.operation.${tool.operation}`);
  if (template === undefined) return generic;
  return fill(template, {
    targetOne: targetNoun(catalogs, targetDatabaseModuleId, "one"),
    targetMany: targetNoun(catalogs, targetDatabaseModuleId, "many"),
  });
}

/**
 * The summary of a step in `locale`, or `null` for a step with nothing to summarize (a call that has not
 * returned). It is chosen by the outcome and, for an operation, by the operation; the only numbers in it
 * are counts the caller derived from structured fields (the changed properties of an `item.patch`, the
 * tool and approval steps of a run), never anything read from a result's text.
 */
export async function stepSummary(locale: string, input: AgentStepSummaryInput): Promise<string | null> {
  const catalogs = await loadCatalogs(locale);
  if (input.kind === "end") {
    const template = lookup(catalogs, "agentStep.summary.end") ?? "agentStep.summary.end";
    return fill(template, {
      tools: pluralText(catalogs, locale, "agentStep.summary.toolCount", input.toolCount),
      approvals: pluralText(catalogs, locale, "agentStep.summary.approvalCount", input.approvalCount),
    });
  }
  if (input.state === "running") return null;
  const key = ((): string => {
    if (input.state === "error") return "agentStep.summary.failed";
    if (input.approval) return "agentStep.summary.approvalRequested";
    if (input.operation === "item.patch" && input.changeCount > 0) return "agentStep.summary.changedProperties";
    return input.operation !== null && lookup(catalogs, `agentStep.summary.operation.${input.operation}`) !== undefined
      ? `agentStep.summary.operation.${input.operation}`
      : "agentStep.summary.done";
  })();
  if (key === "agentStep.summary.changedProperties") return pluralText(catalogs, locale, key, input.changeCount);
  return lookup(catalogs, key) ?? key;
}
