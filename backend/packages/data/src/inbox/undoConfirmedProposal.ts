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

// Reverses a confirmed proposal from what the confirm recorded (stored envelope with `before` values, `results`, and
// the confirmation history entry's edges), not by re-deriving what a confirm would write now. Called by
// `proposalReopen.ts` in the transaction that returns the card to `proposed`.

/** The undo is the person's decision, like the confirm it reverses. */
const UNDOING_USER_WRITER: WriterIdentity = { writerKind: "user" };

/** An item the undo left in place, with why; the client names it to the user. */
export interface KeptItem {
  itemId: string;
  databaseKey: string | null;
  label: string;
  reason: "attachmentMovedToFiles";
}

type ResultRole = "created" | "updated" | "pageContent" | "keptFile" | "edgesOnly";

interface ClassifiedResult {
  result: ConfirmationResult;
  role: ResultRole;
  step: ProposalStep | null;
}

/** A card with no parsable recorded `results` cannot be reversed. */
function readRecordedResults(proposal: ItemRow): ConfirmationResult[] {
  const parsed = z.array(confirmationResultSchema).safeParse(proposal.properties.results ?? []);
  if (!parsed.success || parsed.data.length === 0) {
    throw new ValidationError("The confirmation of this proposal recorded no results that can be reversed", {
      field: "results",
    });
  }
  return parsed.data;
}

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
    // A journal entry is page content inserted into its day: the undo removes the blocks it inserted.
    if (envelope.entityKind === "pageContent" || envelope.entityKind === "journalEntry")
      return { result, role: "pageContent", step: null };
    return { result, role: "edgesOnly", step: null };
  });
  return classified;
}

/** The card's last history entry, written together with the confirmed status. */
function confirmationEntry(proposal: ItemRow) {
  const parsed = z.array(proposalHistoryEntrySchema).safeParse(proposal.properties.history);
  return parsed.success ? (parsed.data.at(-1) ?? null) : null;
}

/**
 * Before any write, locks in id order every item the confirmation created, changed or wrote blocks into: one gone,
 * trashed or with a different `version` refuses with a 409 `version_conflict`. Moved-attachment Files items and
 * merely linked items are not checked, since the undo overwrites neither.
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
    if (!item || item.deletedAt !== null || item.version !== result.version) {
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
 * Reverses only edges between existing items the confirmation recorded as its own (`writtenRelations`, plus the Event
 * participants of `addedRelations`): inserted edges are deleted, replaced metadata restored. An edge that is gone or
 * that the user changed since is left alone; edges of created items stay with them.
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

/** Writes back an update step's `before` properties, then its deleted edges with their metadata; an edge that exists again is left as the user has it. */
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
 * Cancels the `transcriptionCreate` and `transcriptionJob` a transcription card's confirmation queued, then trashes a
 * checkpointed Transcripts item. Lock order matches every producer of these jobs: the Files row, then the job rows,
 * then the transcript; taking job rows first could deadlock with a producer holding the file lock. Locking the file
 * first also lets a pipeline step holding it commit, so its transcript is found. The Files item itself is untouched.
 *
 * Only a confirmation that enqueued the jobs records `transcriptionQueued`, so jobs the user's upload queued are not
 * cancelled when a card reused that Files item.
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
 * Cancels each result's queued follow-up job and removes what it produced. A running job is only detached from its
 * key and not retried (`cancelJob`); it stops once it finds its item in the Trash.
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
 * Reverses a confirmed card's writes in the caller's transaction and returns the kept items: after the precondition,
 * recorded edges, patched items, inserted page blocks, created items (trashed via the choke point, so their edges
 * survive a restore), a created MCP server's credential, then follow-up jobs. Any failure throws.
 *
 * - A Files item that received a moved attachment has no reverse and is returned as a `KeptItem`.
 * - Only edges recorded in the confirmation entry are reversed, so a manually settled speaker card keeps its edges.
 * - A `journalEntry` loses its blocks and inserted `project`/`area` edge, but the Journal day stays.
 * - Not reversed: an Events item materialized for a synthetic occurrence, and the release of a trashed Event edge.
 *
 * The caller has locked the card, handled non-`confirmed` cases and checked `ifVersion`.
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
