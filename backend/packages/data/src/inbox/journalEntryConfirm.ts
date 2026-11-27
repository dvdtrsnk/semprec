import type { PoolClient } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { insertPageMarkdown, parseCheckedMarkdown } from "../docs/pageMarkdown.js";
import { ConflictError, NotFoundError } from "../errors.js";
import { ensureJournalPeriodDoc } from "../journal/journalStore.js";
import { JOURNAL_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { findJournalEntryReferenceProblem, parseJournalEntryProperties } from "./journalEntryEnvelope.js";
import type { ProposalEnvelope } from "./proposalEnvelope.js";
import { createEdgeRecorder, writeRecordedEdge, type EdgeRecorder } from "./proposalEdgeRecording.js";
import { requireRelationPropertyId } from "./proposalItemOrigin.js";
import { proposalBlockId } from "./proposalPageContent.js";

/**
 * A reference that no longer resolves is a `ConflictError` (409), not a malformed proposal, and the card stays
 * `proposed`. A no-op for other envelope kinds.
 */
export async function assertJournalEntryReferencesLive(client: PoolClient, envelope: ProposalEnvelope): Promise<void> {
  if (envelope.entityKind !== "journalEntry") return;
  const problem = await findJournalEntryReferenceProblem(
    client,
    envelope.target,
    parseJournalEntryProperties(envelope.properties),
  );
  if (problem) throw new ConflictError(problem.message, { field: problem.field });
}

export interface ConfirmedJournalEntry {
  resultItemId: string;
  resultLabel: string;
  stepResults: Array<{ ref: string; itemId: string; databaseId: string }>;
  /** In page order. */
  blockIds: string[];
  /** Stored in the confirmation's history entry; the undo reverses only these edges. */
  recordedEdges: EdgeRecorder;
}

/**
 * Runs in the caller's transaction, which also holds the card's row lock and writes `confirmed`, so any failure leaves
 * the card `proposed` and nothing written. The caller has run `assertJournalEntryReferencesLive`.
 *
 * The markdown is authored `user` (the confirming person; Semp's proposal stays on the card). Block `i` has id
 * `proposalBlockId(proposalId, i)`, so a second insert for the same proposal collides instead of duplicating. With a
 * `projectId` the day gets a `project` edge and no `area` edge, because the area derives from the project. The edge is
 * always recorded, so the undo deletes an edge this confirm inserted and keeps one the day already had.
 */
export async function confirmJournalEntry(
  client: PoolClient,
  proposalId: string,
  envelope: ProposalEnvelope,
  writer: WriterIdentity,
  actingUserId: string | undefined,
): Promise<ConfirmedJournalEntry> {
  const properties = parseJournalEntryProperties(envelope.properties);
  const journal = await getDatabaseByModuleId(client, JOURNAL_MODULE_ID);
  if (!journal) throw new NotFoundError("Journal database not found");
  const day = await ensureJournalPeriodDoc(client, "day", properties.date);
  const parsed = await parseCheckedMarkdown(client, properties.markdown);
  const inserted = await insertPageMarkdown(client, day.itemId, {
    placement: "end",
    markdown: properties.markdown,
    blockIds: parsed.map((_, index) => proposalBlockId(proposalId, index)),
    origin: "user",
  });
  const recordedEdges = createEdgeRecorder();
  const relation =
    properties.projectId !== undefined
      ? { key: "project", targetItemId: properties.projectId }
      : properties.areaId !== undefined
        ? { key: "area", targetItemId: properties.areaId }
        : null;
  if (relation !== null) {
    await writeRecordedEdge(
      client,
      recordedEdges,
      {
        relationPropertyId: await requireRelationPropertyId(client, journal.id, relation.key),
        callerItemId: day.itemId,
        targetItemId: relation.targetItemId,
      },
      writer,
      actingUserId,
    );
  }
  return {
    resultItemId: day.itemId,
    resultLabel: day.period,
    stepResults: [{ ref: "primary", itemId: day.itemId, databaseId: journal.id }],
    blockIds: inserted.blockIds,
    recordedEdges,
  };
}
