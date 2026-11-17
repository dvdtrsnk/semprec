import type { PoolClient } from "pg";
import { BlockInputError, parseMarkdown } from "@semprec/block-model";
import { z } from "zod";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { getItemById } from "../chokePoint/itemsStore.js";
import { relationTargetBlock } from "../chokePoint/relationTargetState.js";
import { ValidationError } from "../errors.js";
import { parseJournalPeriodKey } from "../journal/journalPeriods.js";
import { AREAS_MODULE_ID, JOURNAL_MODULE_ID, PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { assertJournalEntryAreaNotDerived } from "./proposalDerivedRelations.js";
import type { ProposalEnvelope } from "./proposalEnvelope.js";

// A `journalEntry` envelope's `target` is the tenant's Journal database; the day it names usually has no Journal item
// yet, and `journalEntryConfirm.ts` creates it.

/** Setting both `areaId` and `projectId` is refused by `assertJournalEntryAreaNotDerived`. */
const journalEntryPropertiesSchema = z.strictObject({
  date: z.string(),
  markdown: z.string(),
  areaId: z.uuid().optional(),
  projectId: z.uuid().optional(),
});

export type JournalEntryProperties = z.infer<typeof journalEntryPropertiesSchema>;

export function parseJournalEntryProperties(properties: Record<string, unknown>): JournalEntryProperties {
  const parsed = journalEntryPropertiesSchema.safeParse(properties);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const field = issue?.code === "unrecognized_keys" ? (issue.keys[0] ?? "properties") : String(issue?.path[0] ?? "");
  throw new ValidationError(
    `A journal entry proposal's property '${field || "properties"}' is invalid (${issue?.message ?? "invalid"})`,
    { field: field || "properties" },
  );
}

function assertValidDay(date: string): void {
  try {
    parseJournalPeriodKey("day", date);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new ValidationError("A journal entry proposal's date is not a calendar date of the form YYYY-MM-DD", {
        field: "date",
      });
    }
    throw error;
  }
}

/** Page blocks are refused. */
function assertValidMarkdown(markdown: string): void {
  if (markdown.trim().length === 0) {
    throw new ValidationError("A journal entry proposal's markdown must not be empty", { field: "markdown" });
  }
  try {
    parseMarkdown(markdown, { allowPage: false });
  } catch (error) {
    if (error instanceof BlockInputError) {
      throw new ValidationError("A journal entry proposal's markdown is not valid Markdown without page blocks", {
        field: "markdown",
        reason: error.issues[0]?.code ?? "invalid_markdown",
      });
    }
    throw error;
  }
}

export interface JournalEntryReferenceProblem {
  field: "target" | "areaId" | "projectId";
  message: string;
}

/** Uses the relation write's own rule (`relationTargetBlock`), so a reference that passes is one confirm accepts. */
async function isLinkableItemOf(client: PoolClient, moduleId: string, itemId: string): Promise<boolean> {
  const database = await databasesStore.getDatabaseByModuleId(client, moduleId);
  const item = database ? await getItemById(client, database.id, itemId) : null;
  return item !== null && relationTargetBlock(item, moduleId) === null;
}

/** Another tenant's id resolves to nothing, so it is the same problem as a random id. */
export async function findJournalEntryReferenceProblem(
  client: PoolClient,
  target: string,
  properties: JournalEntryProperties,
): Promise<JournalEntryReferenceProblem | null> {
  const journal = await databasesStore.getDatabaseByModuleId(client, JOURNAL_MODULE_ID);
  if (!journal || journal.id !== target) {
    return { field: "target", message: `A journal entry proposal's target '${target}' is not the Journal database` };
  }
  const references = [
    { field: "areaId", moduleId: AREAS_MODULE_ID, itemId: properties.areaId },
    { field: "projectId", moduleId: PROJECTS_MODULE_ID, itemId: properties.projectId },
  ] as const;
  for (const { field, moduleId, itemId } of references) {
    if (itemId !== undefined && !(await isLinkableItemOf(client, moduleId, itemId))) {
      return {
        field,
        message: `A journal entry proposal's ${field} '${itemId}' is not a live item of ${moduleId} that a relation may point at`,
      };
    }
  }
  return null;
}

/**
 * Reached through `assertValidProposalEnvelope` from both the tick and a revise. Refuses `operations`, `relations`, a
 * non-calendar `date`, blank or invalid markdown or a `page` block, both `projectId` and `areaId`, and references that
 * do not resolve in the current tenant. Resolves to `null` (no target database row).
 */
export async function assertValidJournalEntryEnvelope(client: PoolClient, envelope: ProposalEnvelope): Promise<null> {
  if (envelope.operations !== undefined)
    throw new ValidationError("A journal entry proposal has no steps", { field: "operations" });
  if (envelope.relations !== undefined)
    throw new ValidationError("A journal entry proposal has no relations", { field: "relations" });
  const properties = parseJournalEntryProperties(envelope.properties);
  assertValidDay(properties.date);
  assertValidMarkdown(properties.markdown);
  assertJournalEntryAreaNotDerived(properties);
  const problem = await findJournalEntryReferenceProblem(client, envelope.target, properties);
  if (problem) throw new ValidationError(problem.message, { field: problem.field });
  return null;
}
