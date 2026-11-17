import type { ModuleCatalog } from "@semprec/module-registry";
import type { GenericOperationName } from "@semprec/shared";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import { getAgentRunCatalogs } from "./agentRunErrorSummary.js";
import { fill } from "./catalogFill.js";

/**
 * The one place that turns a tool call into text (the per-reply step summary reads the same entries). Nothing
 * localized is stored, so a locale change applies to earlier runs too.
 */

/** A tool stored without identity is known only by its model-facing name. */
export type AgentStepTool =
  | { kind: "operation"; operation: GenericOperationName }
  | { kind: "mcp"; toolName: string }
  | { kind: "named"; toolName: string }
  | { kind: "unknown" };

export type AgentStepPlainKind = "start" | "plan" | "answer" | "end" | "error";

/** Structured facts only, never a result text. */
export type AgentStepSummaryInput =
  | { kind: "end"; toolCount: number; approvalCount: number }
  | {
      kind: "tool";
      state: "running" | "ok" | "error";
      operation: GenericOperationName | null;
      approval: boolean;
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

function lookup(catalogs: Catalogs, key: string): string | undefined {
  return catalogs.locale[key] ?? catalogs.en[key];
}

/** `${base}.zero` for 0 when present, else the locale's plural category, else `${base}.other` (every group has it). */
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

export async function stepKindTitle(locale: string, kind: AgentStepPlainKind): Promise<string> {
  const catalogs = await loadCatalogs(locale);
  const key = `agentStep.title.${kind}`;
  return lookup(catalogs, key) ?? key;
}

/**
 * A generic operation fills in the noun of the target database's module (`database.query` over tasks reads
 * "Searching tasks"); an unknown module reads the generic noun, an operation without an entry "Using a tool".
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
 * `null` for a call that has not returned. The only numbers are counts derived from structured fields, never from
 * a result's text.
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
