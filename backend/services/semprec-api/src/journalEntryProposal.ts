import { z } from "zod";
import { createLogger } from "@semprec/shared";
import type { ProposalComputationResult, ProposalWorkspaceGroup } from "@semprec/data";

const logger = createLogger("journal-entry-proposal");

/**
 * The instruction added to the system prompt of an item whose type has the `journal` processing method (issue
 * gh-1982). The model writes only the entry; the server supplies the Journal database as the target.
 */
export const JOURNAL_ENTRY_INSTRUCTION =
  "For a journal-method type, write one entry for a day of the person's Journal. Return 'markdown', the entry's nonempty Markdown body without page blocks or page links. Return 'date' (YYYY-MM-DD) only when the item names a day other than its own date; leave it out otherwise. Return 'projectId' or 'areaId' only when the item clearly belongs to one of the projects or areas of the workspace context, taking the id from that list; never invent one. Do not return a target or a properties object.";

/** The model's answer for a journal entry, validated before it leaves this module (`content` is `unknown` at the gateway boundary). Keys outside it are ignored. */
const journalEntryAnswerSchema = z.object({
  date: z.string().min(1).optional(),
  markdown: z.string(),
  areaId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  reason: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

/** The same shape as `journalEntryAnswerSchema`, as the Draft 2020-12 JSON Schema the gateway forwards to the provider. */
export const JOURNAL_ENTRY_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    date: { type: "string", description: "The day of the entry as YYYY-MM-DD. Omit to use the item's own date." },
    markdown: { type: "string", description: "The entry's Markdown body." },
    areaId: { type: "string", description: "The id of an area of the workspace context. Omit when unsure." },
    projectId: { type: "string", description: "The id of a project of the workspace context. Omit when unsure." },
    reason: { type: "string", description: "A short explanation of the proposal." },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["markdown"],
  additionalProperties: false,
} as const;

/** The ids the workspace context lists for `moduleId`. */
function listedIds(workspace: ProposalWorkspaceGroup[], moduleId: ProposalWorkspaceGroup["moduleId"]): Set<string> {
  return new Set(
    workspace.filter((group) => group.moduleId === moduleId).flatMap((group) => group.items.map((item) => item.id)),
  );
}

/**
 * Turns the model's answer for a journal entry into the computation result: `properties` are `{markdown, date?,
 * areaId?, projectId?}` and no `target`. An area or project the workspace context did not list is dropped, as the
 * relation targets of a database proposal are (`filterModelReferences`), so the envelope never carries an id the model
 * took from nowhere. An answer that does not match the schema throws.
 */
export function parseJournalEntryAnswer(
  content: unknown,
  workspace: ProposalWorkspaceGroup[],
): ProposalComputationResult {
  const answer = journalEntryAnswerSchema.parse(content);
  const { reason, confidence, ...entry } = answer;
  let dropped = 0;
  if (entry.areaId !== undefined && !listedIds(workspace, "areas").has(entry.areaId)) {
    delete entry.areaId;
    dropped++;
  }
  if (entry.projectId !== undefined && !listedIds(workspace, "projects").has(entry.projectId)) {
    delete entry.projectId;
    dropped++;
  }
  if (dropped > 0) logger.info({ count: dropped }, "Dropped journal entry references");
  return {
    properties: entry,
    ...(reason === undefined ? {} : { reason }),
    ...(confidence === undefined ? {} : { confidence }),
  };
}
