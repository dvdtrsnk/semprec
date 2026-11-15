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

// The envelope of the card that proposes an entry on a Journal day (issue gh-1975): an `inbox` card whose envelope kind
// is `journalEntry`, whose `target` is the id of the tenant's Journal database and whose `properties` are
// `{ date, markdown, areaId?, projectId? }`. The day it names usually has no Journal item yet; the confirm that
// creates it and writes the entry is `journalEntryConfirm.ts` (issue gh-1981).

/**
 * A journal entry card's envelope `properties`. `date` is the day's `YYYY-MM-DD` key and `markdown` the entry's body;
 * both are checked beyond their type by `assertValidJournalEntryEnvelope`. `areaId` and `projectId` are the optional
 * Areas and Projects items the entry is related to; each is checked on its own, and an envelope that sets both is
 * refused by `assertJournalEntryAreaNotDerived` (issue gh-1991).
 */
const journalEntryPropertiesSchema = z.strictObject({
  date: z.string(),
  markdown: z.string(),
  areaId: z.uuid().optional(),
  projectId: z.uuid().optional(),
});

export type JournalEntryProperties = z.infer<typeof journalEntryPropertiesSchema>;

/**
 * Parses a journal entry envelope's `properties`. An unknown key, a missing `date` or `markdown` and a value of the
 * wrong type are a `ValidationError` naming the field.
 */
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

/** A `YYYY-MM-DD` that names a day of the calendar (`2026-02-30` does not), or a `ValidationError` on `date`. */
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

/** `markdown` as the Markdown parser reads it, page blocks refused; a `ValidationError` on `markdown` otherwise. */
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

/** What no longer holds of a journal entry's references: the field that names it and the message. */
export interface JournalEntryReferenceProblem {
  field: "target" | "areaId" | "projectId";
  message: string;
}

/**
 * Whether `itemId` is a live item of the database owned by `moduleId` in the current tenant that the day's edge may
 * point at: not in the Trash and, for a project, not archived (`relationTargetBlock`, the rule the relation write
 * refuses by), so a reference that passes here is one the confirm's edge write accepts.
 */
async function isLinkableItemOf(client: PoolClient, moduleId: string, itemId: string): Promise<boolean> {
  const database = await databasesStore.getDatabaseByModuleId(client, moduleId);
  const item = database ? await getItemById(client, database.id, itemId) : null;
  return item !== null && relationTargetBlock(item, moduleId) === null;
}

/**
 * The first reference of the envelope that does not resolve in the current tenant, or `null`: `target` that is not the
 * tenant's Journal database, then `areaId` that is not a live item of the Areas database, then `projectId` that is not
 * a live, unarchived item of the Projects database. Another tenant's id resolves to nothing, so it is the same problem
 * as a random id.
 */
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
 * Validates a `journalEntry` envelope wherever it is written, the Inbox tick and a revise (both reach it through
 * `assertValidProposalEnvelope`): no `operations` and no `relations`; `properties` that `parseJournalEntryProperties`
 * accepts; `date` a day of the calendar; `markdown` not blank and valid Markdown (`parseMarkdown`) without a `page`
 * block; not both `projectId` and `areaId`, because the area is derived from the project
 * (`assertJournalEntryAreaNotDerived`, issue gh-1991); `target` the Journal database of the current tenant; and, when set, `areaId` a live item of the Areas database
 * and `projectId` a live, unarchived item of the Projects database of the current tenant. Each refusal is a `ValidationError`
 * naming the field. Resolves to `null`, as `assertValidProposalEnvelope` does for an envelope that has no target
 * database row to return.
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
