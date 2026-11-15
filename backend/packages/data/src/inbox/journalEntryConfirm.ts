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

// The confirm of a `journalEntry` card (issue gh-1981), called by `confirmProposalWithClient` in its own transaction.
// The envelope and its validation are in `journalEntryEnvelope.ts`.

/**
 * The confirm-time check of the references of a stored `journalEntry` envelope: the Journal database, the area and the
 * project must still resolve, as they did when the envelope was validated. A reference that no longer does is a
 * `ConflictError` (409) naming the field, not a malformed proposal, and the card stays `proposed`. The properties are
 * parsed as `parseJournalEntryProperties` does, so a malformed envelope is its `ValidationError`. It does nothing for an
 * envelope of another kind.
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

/** What `confirmJournalEntry` wrote, in the form `confirmProposalWithClient` records on the card. */
export interface ConfirmedJournalEntry {
  /** The Journal day the entry is on. */
  resultItemId: string;
  /** The `YYYY-MM-DD` key of the day. */
  resultLabel: string;
  /** The one step result, the day. */
  stepResults: Array<{ ref: string; itemId: string; databaseId: string }>;
  /** The ids of the inserted blocks, in page order. */
  blockIds: string[];
  /** The edge the confirm wrote to the day, for the history entry of the confirmation (the undo reverses only it). */
  recordedEdges: EdgeRecorder;
}

/**
 * Writes a confirmed journal entry in the caller's transaction, which also holds the card's row lock and writes its
 * `confirmed` status, so a failure at any step leaves the card `proposed` and nothing written:
 *
 * 1. The day's item and its page are created when missing (`ensureJournalPeriodDoc`, kind `day`).
 * 2. `properties.markdown` is inserted at the end of the page (`insertPageMarkdown`), authored `user`: the person who
 *    confirmed it; that Semp proposed it stays recorded on the card. Block number `i` has the id
 *    `proposalBlockId(proposalId, i)`, so the blocks written for this proposal are recognisable and a second insert for
 *    it collides on their ids instead of adding a copy.
 * 3. With a `projectId` the day gets a `project` edge and no `area` edge of its own, because the entry's area is the
 *    project's; with only an `areaId` it gets an `area` edge. The edge is written with `writeRecordedEdge` into
 *    the returned `recordedEdges` (an edge that is absent is inserted, one that is there is rewritten with the same empty metadata, so no
 *    edge is duplicated), and the caller stores the record in the confirmation's history entry, so the undo deletes
 *    an edge this confirm inserted and leaves one the day already had
 *    (`docs/adr/2026-11-14-the-undo-of-a-confirmation-reverses-only-the-edges-it-recorded.md`). The day is an existing
 *    item whichever way it came to be, so its edge is always recorded.
 *
 * The caller has run `assertJournalEntryReferencesLive`. Returns the day and the inserted block ids.
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
