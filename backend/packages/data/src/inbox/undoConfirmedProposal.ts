import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { PoolClient } from "pg";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import {
  createRelationIfAbsentWithClient,
  createRelationWithClient,
  deleteRelationWithClient,
} from "../chokePoint/relationOps.js";
import { createActionQueueAffinity, type ActionQueueAffinity } from "../scheduler/actions.js";
import { deleteCredential } from "../credentials/externalCredentialsStore.js";
import { deleteBlocksWithClient } from "../docs/docStore.js";
import { lockLiveItem } from "../docs/lockLiveItem.js";
import { ConflictError, ValidationError } from "../errors.js";
import { cancelMcpServerSync } from "../mcp/mcpSync.js";
import { MCP_SERVERS_MODULE_ID } from "../seed/mcpModuleKeys.js";
import { TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { TRANSCRIPTION_CREATE_COMPUTED_KEY } from "../transcription/transcriptionComputedKeys.js";
import { cancelTranscriptionJobs, readTranscriptionSourceFileItemId } from "../transcription/transcriptionJob.js";
import type { ItemRow } from "../types.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { parseStoredProposalEnvelope, type ProposalEnvelope } from "./proposalEnvelope.js";
import { proposalHistoryEntrySchema, type ProposalHistoryEntry } from "./proposalHistory.js";
import { deleteItemOriginsOfProposal } from "./itemOriginsStore.js";
import { edgeIsAsWritten, readEdge } from "./proposalEdgeRecording.js";
import type { ProposalStep } from "./inboxTickAction.js";
import { unsupportedEntityKindError, confirmationResultSchema, type ConfirmationResult } from "./proposalActions.js";

/**
 * The reversal of a confirmed Processing proposal (issue #1943), following
 * `docs/adr/2026-10-25-undoing-a-confirmed-proposal-reverses-its-recorded-writes.md`. It is driven by what the confirm
 * recorded on the card: its stored envelope (the steps and the `before` values of the update steps), its `results` (the
 * item, `updatedAt` and inserted block ids of every step) and the history entry of the confirmation (the edges it
 * recorded as its own insertions), not by re-deriving what a confirm would write now. The origin rows of the items it
 * created are removed with them. `proposalReopen.ts` calls it in the transaction that returns the card to `proposed`.
 */

/** The user's own writes: the undo is the person's decision, like the confirm it reverses. */
const UNDOING_USER_WRITER: WriterIdentity = { writerKind: "user" };

/** An item the undo left in place, with why; the client names it to the user. */
export interface KeptItem {
  itemId: string;
  databaseKey: string | null;
  label: string;
  reason: "attachmentMovedToFiles";
}

/** What the confirm of this card did to each result: it created the item, changed it, or only wrote edges from it. */
type ResultRole = "created" | "updated" | "pageContent" | "keptFile" | "edgesOnly";

interface ClassifiedResult {
  result: ConfirmationResult;
  role: ResultRole;
  step: ProposalStep | null;
}

/** The stored `results` of the card; a card with none recorded, or one that does not parse, cannot be reversed. */
function readRecordedResults(proposal: ItemRow): ConfirmationResult[] {
  const parsed = z.array(confirmationResultSchema).safeParse(proposal.properties.results ?? []);
  if (!parsed.success || parsed.data.length === 0) {
    throw new ValidationError("The confirmation of this proposal recorded no results that can be reversed", {
      field: "results",
    });
  }
  return parsed.data;
}

/** The result of every step of the card, classified by what the confirm did with its item. */
function classifyResults(envelope: ProposalEnvelope, results: ConfirmationResult[]) {
  const steps = new Map((envelope.operations ?? []).map((step) => [step.ref, step]));
  const classified: ClassifiedResult[] = results.map((result) => {
    const step = steps.get(result.ref) ?? null;
    if (step) {
      const roles = {
        create: "created",
        update: "updated",
        link: "edgesOnly",
        fileFromAttachment: "keptFile",
      } as const;
      return { result, role: roles[step.op], step };
    }
    if (envelope.entityKind === "database") return { result, role: "created", step: null };
    // A journal entry is page content inserted into its day: the undo removes the blocks it inserted (issue gh-1981).
    if (envelope.entityKind === "pageContent" || envelope.entityKind === "journalEntry")
      return { result, role: "pageContent", step: null };
    return { result, role: "edgesOnly", step: null };
  });
  return classified;
}

/** The history entry of the confirmation: the card's last one, which the confirm wrote together with the status. */
function confirmationEntry(proposal: ItemRow) {
  const parsed = z.array(proposalHistoryEntrySchema).safeParse(proposal.properties.history);
  return parsed.success ? (parsed.data.at(-1) ?? null) : null;
}

/**
 * Checks every item the confirmation created, changed or wrote page blocks into, before anything is written, with the
 * row of each locked in id order: an item that is gone, in the Trash, or whose `updatedAt` is no longer the stored one
 * refuses the undo with the 409 `version_conflict` that names it. A Files item that received a moved attachment, and an
 * item the confirmation only linked, are not checked: the undo overwrites neither.
 */
async function assertNothingChanged(client: PoolClient, checked: ClassifiedResult[]): Promise<void> {
  const ids = [...new Set(checked.map(({ result }) => result.itemId))].sort();
  const found = new Map((await itemsStore.getItemsByIdsIncludingDeleted(client, ids)).map((item) => [item.id, item]));
  const current = new Map<string, ItemRow | null>();
  for (const id of ids) {
    const visible = found.get(id);
    current.set(id, visible ? await itemsStore.lockItemById(client, visible.databaseId, id) : null);
  }
  for (const { result } of checked) {
    const item = current.get(result.itemId);
    if (!item || item.deletedAt !== null || item.updatedAt !== result.updatedAt) {
      throw new ConflictError("An item the confirmation wrote was changed since, so the undo would overwrite it", {
        itemId: result.itemId,
        databaseKey: result.databaseKey,
        label: result.label,
      });
    }
  }
}

async function deleteEdge(
  client: PoolClient,
  input: { relationPropertyId: string; callerItemId: string; targetItemId: string },
  actingUserId: string | undefined,
): Promise<void> {
  await deleteRelationWithClient(client, input, undefined, UNDOING_USER_WRITER, actingUserId);
}

/**
 * (a) Reverses the edges between existing items that the confirmation recorded as its own writes (`writtenRelations`,
 * and the Event participant edges of `addedRelations`), and nothing else: an edge that was there before the confirmation
 * is never deleted. An edge the confirmation inserted is deleted; an edge it found and whose metadata it replaced gets
 * that metadata back. An edge that is gone, or whose metadata the user changed after the confirmation, is left as it is.
 * Edges from an item the confirmation created stay with that item.
 */
async function reverseWrittenEdges(
  client: PoolClient,
  entry: ProposalHistoryEntry | null,
  createdIds: Set<string>,
  actingUserId: string | undefined,
): Promise<void> {
  for (const written of entry?.writtenRelations ?? []) {
    if (createdIds.has(written.callerItemId)) continue;
    const current = await readEdge(client, written);
    if (!current || !edgeIsAsWritten(current, written)) continue;
    if (written.previousMetadata === null) {
      await deleteEdge(client, written, actingUserId);
    } else if (!isDeepStrictEqual(written.previousMetadata, written.metadata)) {
      await createRelationWithClient(
        client,
        { ...written, metadata: written.previousMetadata },
        undefined,
        UNDOING_USER_WRITER,
        actingUserId,
      );
    }
  }
  // Edges the confirm recorded as its own insertions (the Event participants of a speaker card).
  for (const edge of entry?.addedRelations ?? []) {
    if (createdIds.has(edge.callerItemId)) continue;
    await deleteEdge(client, edge, actingUserId);
  }
}

/**
 * (b) Writes back the properties an update step recorded as `before`, then the edges an update step deleted, each with
 * the metadata it had (`removedRelations`). An edge that exists again is left as the user has it.
 */
async function restoreUpdatedItems(
  client: PoolClient,
  classified: ClassifiedResult[],
  entry: ProposalHistoryEntry | null,
  actingUserId: string | undefined,
): Promise<void> {
  for (const { result, role, step } of classified) {
    if (role !== "updated" || step === null) continue;
    const [item] = await itemsStore.getItemsByIds(client, [result.itemId]);
    if (!item) continue;
    const before = step.before?.properties ?? {};
    if (Object.keys(before).length === 0) continue;
    await updateItemWithClient(
      client,
      {
        databaseId: item.databaseId,
        itemId: item.id,
        propertiesPatch: Object.fromEntries(Object.entries(before).map(([key, value]) => [key, value ?? null])),
      },
      { writer: UNDOING_USER_WRITER, actingUserId },
    );
  }
  for (const removed of entry?.removedRelations ?? []) {
    await createRelationIfAbsentWithClient(client, removed, undefined, UNDOING_USER_WRITER, actingUserId);
  }
}

/**
 * (f) Cancels what the confirmation of a transcription card queued (issue gh-1984): the `transcriptionCreate` and
 * `transcriptionJob` of its Files item (`cancelTranscriptionJobs`), then, when a job already ran and checkpointed a
 * Transcripts item on the file, that item goes to the Trash. The locks are taken in the order every producer of these
 * jobs takes them (`recordRecordingIntake`, the upload, a rerun): the Files row first, then the job rows its enqueue
 * upserts, then the transcript. The file row is therefore locked before the jobs are removed, which also lets a step of
 * the pipeline that holds the file commit first, after which the undo finds its transcript. Taking the job rows first
 * would wait for the file lock while holding a job row that a producer holding the file lock is waiting for, and
 * PostgreSQL would abort one of the two with a deadlock. A transcript that is already in the Trash or purged changes
 * nothing. The Files item itself is not touched: it is the confirmation's own move, which
 * `undoConfirmedProposalWithClient` leaves as it is.
 *
 * Only a confirmation that enqueued the jobs itself records `transcriptionQueued` (`confirmRecordingCard`), so the jobs
 * of a Files item that the user's own upload had already queued are not cancelled by the undo of a card that reused it.
 */
async function cancelRecordingTranscription(
  client: PoolClient,
  fileItemId: string,
  options: { queueAffinity: ActionQueueAffinity; actingUserId: string | undefined },
): Promise<void> {
  const [visible] = await itemsStore.getItemsByIdsIncludingDeleted(client, [fileItemId]);
  const file = visible ? await itemsStore.lockItemById(client, visible.databaseId, visible.id) : null;
  await cancelTranscriptionJobs(client, fileItemId);
  const checkpoint = file?.computed[TRANSCRIPTION_CREATE_COMPUTED_KEY];
  if (checkpoint === undefined) return;
  const transcriptId = z.uuid().parse(checkpoint);
  const transcripts = await databasesStore.getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
  if (!transcripts) throw new Error(`Database for module '${TRANSCRIPTS_MODULE_ID}' not found`);
  const deleted = await itemDeleteWithClient(client, transcripts.id, transcriptId, {
    ...options,
    writer: UNDOING_USER_WRITER,
  });
  // The trash above is rolled back with the undo when the checkpoint named a transcript of another file.
  if (deleted && readTranscriptionSourceFileItemId(deleted.properties.link) !== fileItemId) {
    throw new Error(`Transcript ${transcriptId} is not the transcript of Files item ${fileItemId}`);
  }
}

/**
 * (f) For every result whose confirmation queued a follow-up job (`results[].followUp`), cancels that job in the undo's
 * transaction and removes what it already produced. `mcpSyncQueued` removes the sync job of the server item; the item is
 * in the Trash by then, and the readers that offer or invoke a tool (`mcpAgentTools.ts`, `mcpToolInvocation.ts`,
 * `mcpAgentPageGrants.ts`) join the live server item, so the registrations of a sync that already ran are no longer
 * offered. `transcriptionQueued` is `cancelRecordingTranscription`. A job a worker is already running is not
 * stopped, only detached from its key and not retried (`cancelJob`): an MCP sync ends without writing once it finds the
 * server item in the Trash, and a transcription run stops at its next step once it finds the transcript in the Trash.
 * A create step that is running when the undo commits and has not written its checkpoint is not stopped, because the
 * Files item stays live: it creates its transcript after the undo. A result without a follow-up touches no job.
 */
async function cancelFollowUps(
  client: PoolClient,
  classified: ClassifiedResult[],
  options: { queueAffinity: ActionQueueAffinity; actingUserId: string | undefined },
): Promise<void> {
  for (const { result } of classified) {
    if (result.followUp === "mcpSyncQueued") await cancelMcpServerSync(client, result.itemId);
    if (result.followUp === "transcriptionQueued") await cancelRecordingTranscription(client, result.itemId, options);
  }
}

/**
 * Reverses a confirmed card's writes in the caller's transaction, under the card's row lock, and returns the items it
 * kept. The precondition comes first and writes nothing; then, in this order: the edges between existing items that the
 * confirmation recorded as its own writes (`reverseWrittenEdges`), the `before` values of patched items and the edges
 * they lost (`restoreUpdatedItems`), the page blocks the confirmation inserted, the items it created (to the Trash, each
 * with its origin row removed), the credential stored for a created MCP server, and last the follow-up jobs it queued
 * (`cancelFollowUps`). A failure at any point throws, and the caller's transaction undoes every earlier write.
 *
 * - An item the confirmation created is trashed with the item delete of the choke point, so its relation edges stay and a
 *   restore from the Trash brings it back with them. A Files item that received a moved Inbox attachment (a
 *   `fileFromAttachment` step) is neither checked nor trashed, and keeps its origin row: the move has no reverse, so the
 *   item is returned as a `KeptItem`.
 * - Only the edges the history entry of the confirmation records are reversed, so the edges and the Event participant of a
 *   card that `settleSpeakerCardWithClient` closed after a manual speaker assignment, which recorded none, stay as the
 *   user made them (`docs/adr/2026-11-12-a-manual-speaker-assignment-settles-the-key-card-in-the-confirm-lock-order.md`),
 *   and so do the edges of a card confirmed before the confirm recorded them.
 * - A confirmed `journalEntry` card is reversed as a page insert into its day: the blocks it inserted are removed, the
 *   day's `project` or `area` edge is deleted when the confirmation inserted it (it is in `writtenRelations`), and the
 *   Journal day stays, empty if the confirmation created it, because days are created lazily and an empty one is what
 *   every day without an entry is (`docs/adr/2026-11-14-undoing-a-journal-entry-confirmation-leaves-its-day.md`).
 * - The limits of the reversal are in
 *   `docs/adr/2026-11-14-the-undo-of-a-confirmation-reverses-only-the-edges-it-recorded.md`: the Events item of a synthetic
 *   occurrence that a `relation` confirm materialized stays, and so does the Trash release of an earlier trashed Event edge
 *   of a transcript card.
 *
 * The caller has locked the card, answered the cases that are not a `confirmed` one and checked `ifVersion`.
 */
export async function undoConfirmedProposalWithClient(
  client: PoolClient,
  proposal: ItemRow,
  actingUserId: string | undefined,
): Promise<KeptItem[]> {
  const entry = confirmationEntry(proposal);
  const envelope = parseStoredProposalEnvelope(proposal.properties.proposal, proposal.id);
  if (!envelope) throw new ValidationError("Proposal has no stored envelope to reverse", { field: "proposal" });
  if ("unknownKind" in envelope) throw unsupportedEntityKindError(envelope.entityKind);
  const classified = classifyResults(envelope, readRecordedResults(proposal));

  await assertNothingChanged(
    client,
    classified.filter(({ role }) => role === "created" || role === "updated" || role === "pageContent"),
  );

  const created = classified.filter(({ role }) => role === "created");
  const createdIds = new Set(created.map(({ result }) => result.itemId));
  await reverseWrittenEdges(client, entry, createdIds, actingUserId);
  await restoreUpdatedItems(client, classified, entry, actingUserId);

  for (const { result, role } of classified) {
    if (role !== "pageContent" || result.blockIds.length === 0) continue;
    await lockLiveItem(client, result.itemId);
    await deleteBlocksWithClient(client, result.itemId, result.blockIds, "user");
  }

  const affinity = createActionQueueAffinity();
  for (const { result } of [...created].reverse()) {
    const [item] = await itemsStore.getItemsByIds(client, [result.itemId]);
    if (!item) continue;
    await itemDeleteWithClient(client, item.databaseId, item.id, {
      queueAffinity: affinity,
      actingUserId,
      writer: UNDOING_USER_WRITER,
    });
  }
  await deleteItemOriginsOfProposal(client, proposal.id, [...createdIds]);
  for (const { result } of created) {
    const [item] = await itemsStore.getItemsByIdsIncludingDeleted(client, [result.itemId]);
    const database = item ? await databasesStore.getDatabase(client, item.databaseId) : null;
    if (item && database?.ownerModuleId === MCP_SERVERS_MODULE_ID) await deleteCredential(client, item.id);
  }
  await cancelFollowUps(client, classified, { queueAffinity: affinity, actingUserId });

  const kept: KeptItem[] = [];
  for (const { result, role } of classified) {
    if (role !== "keptFile") continue;
    const [item] = await itemsStore.getItemsByIds(client, [result.itemId]);
    if (item) {
      kept.push({
        itemId: result.itemId,
        databaseKey: result.databaseKey,
        label: result.label,
        reason: "attachmentMovedToFiles",
      });
    }
  }
  return kept;
}
