// The action items of a transcript's meeting notes, the task a user makes of one and its undo. Both
// writers lock the transcript's item row before reading state and write through
// `./transcriptActionItemStates.ts`.
import type { PoolClient } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createItemWithRelationsWithClient } from "../chokePoint/itemCreateWithRelations.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { NotFoundError } from "../errors.js";
import type { ActionQueueAffinity } from "../scheduler/actions.js";
import { EVENTS_MODULE_ID, TASKS_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { getSelfPersonId } from "../selfPerson.js";
import type { ItemRow } from "../types.js";
import { parseStoredMeetingNotes, renderMeetingNotes } from "./meetingNotesRendering.js";
import {
  clearActionItemState,
  listActionItemStates,
  setActionItemState,
  type TranscriptActionItemState,
} from "./transcriptActionItemStates.js";
import { readLiveTranscriptEventId } from "./transcriptEventEdges.js";
import { TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY } from "./transcriptionComputedKeys.js";
import { listTranscriptSpeakers } from "./transcriptionSpeakerEdges.js";

export interface TranscriptActionItem {
  /** Position in the stored `computed.meetingNotes.actionItems`. */
  id: number;
  text: string;
  ownerSpeaker: string | null;
  ownerLabel: string | null;
  due: string | null;
  startsAt: number | null;
  /** `open` also for an `added` item whose task is not live. */
  state: "open" | TranscriptActionItemState;
  taskId: string | null;
  /** Owner speaker is mapped, through a `speakers` edge, to the tenant's own person. */
  isMine: boolean;
}

/**
 * An item reads `added` only while its task is live; with the task trashed or purged it reads `open`
 * with no `taskId`. `isMine` compares the owner speaker's person with System settings `selfPerson`.
 * An unknown, trashed or note-less transcript has no items.
 */
export async function listTranscriptActionItems(
  client: PoolClient,
  transcriptId: string,
  locale: string,
): Promise<TranscriptActionItem[]> {
  const transcripts = await getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
  const transcript = transcripts && (await itemsStore.getItemById(client, transcripts.id, transcriptId));
  if (!transcript || transcript.deletedAt) return [];
  const notes = parseStoredMeetingNotes(transcript.computed[TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY]);
  if (!notes) return [];
  const speakers = await listTranscriptSpeakers(client, transcript.id, transcript);
  const rendered = await renderMeetingNotes(notes, speakers, locale);
  const states = new Map((await listActionItemStates(client, transcript.id)).map((row) => [row.actionItemId, row]));
  const taskIds = [...states.values()].flatMap((row) =>
    row.state === "added" && row.taskItemId !== null ? [row.taskItemId] : [],
  );
  const liveTaskIds = new Set((await itemsStore.getItemsByIds(client, taskIds)).map((task) => task.id));
  const ownPersonId = await getSelfPersonId(client);
  const personBySpeaker = new Map(speakers.map((entry) => [entry.speaker, entry.person?.id ?? null]));
  return rendered.actionItems.map((item) => {
    const stored = states.get(item.id);
    const taskItemId = stored?.state === "added" ? stored.taskItemId : null;
    const taskId = taskItemId !== null && liveTaskIds.has(taskItemId) ? taskItemId : null;
    const state = stored === undefined || (stored.state === "added" && taskId === null) ? "open" : stored.state;
    const ownerPersonId = item.ownerSpeaker === null ? null : (personBySpeaker.get(item.ownerSpeaker) ?? null);
    return { ...item, state, taskId, isMine: ownPersonId !== null && ownerPersonId === ownPersonId };
  });
}

/** One error for unknown, other-tenant and trashed transcripts and a missing action item, so none is distinguishable. */
function actionItemNotFound(transcriptId: string, actionItemId: number): NotFoundError {
  return new NotFoundError("Transcript action item not found", {
    resource: "transcriptActionItem",
    transcriptId,
    actionItemId,
  });
}

/** `null` for a transcript outside the tenant in scope or in the Trash. */
async function lockLiveTranscript(client: PoolClient, transcriptId: string): Promise<ItemRow | null> {
  const transcripts = await getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
  const transcript = transcripts && (await itemsStore.lockItemById(client, transcripts.id, transcriptId));
  return transcript && !transcript.deletedAt ? transcript : null;
}

export interface ActionItemTaskRequest {
  transcriptId: string;
  actionItemId: number;
  userId: string;
  queueAffinity: ActionQueueAffinity;
}

/**
 * Makes a task of one action item, in the caller's transaction, under the transcript row lock. An
 * `added` item with a live task is answered with it and nothing is written. Otherwise the task is
 * created as the user with a `sourceEvents` edge to the transcript's live Event (link rules fill its
 * project and people). The idempotency key `transcript-action-item:<transcriptId>:<actionItemId>`
 * returns a live reserved item unchanged (`created` false); the store releases a reservation whose
 * item is trashed or purged. The state row becomes `added`, replacing a `noted` row.
 *
 * The Event is read without a lock: one trashed before the edge is written makes the relation write
 * throw `validation_failed`.
 */
export async function createActionItemTask(
  client: PoolClient,
  input: ActionItemTaskRequest & { name?: string; date?: string; locale: string },
): Promise<{ taskId: string; created: boolean }> {
  const transcript = await lockLiveTranscript(client, input.transcriptId);
  const actionItem =
    transcript && (await listTranscriptActionItems(client, transcript.id, input.locale))[input.actionItemId];
  if (!transcript || !actionItem) throw actionItemNotFound(input.transcriptId, input.actionItemId);
  if (actionItem.taskId !== null) return { taskId: actionItem.taskId, created: false };

  const tasks = await getDatabaseByModuleId(client, TASKS_MODULE_ID);
  const sourceEvents = tasks && (await getPropertyByKey(client, tasks.id, "sourceEvents"));
  // The seed gives every tenant both.
  if (!tasks || !sourceEvents) throw new Error("The Tasks database or its 'sourceEvents' relation is missing");
  const eventId = await readLiveTranscriptEventId(client, transcript.databaseId, transcript.id);
  const idempotencyKey = `transcript-action-item:${transcript.id}:${input.actionItemId}`;
  const replayed = await itemsStore.findIdempotentReplay(client, tasks.id, idempotencyKey, { requireLive: true });
  const date = input.date ?? actionItem.due;
  const task = await createItemWithRelationsWithClient(
    client,
    {
      databaseId: tasks.id,
      properties: { name: input.name ?? actionItem.text, ...(date === null ? {} : { date }), status: "notDone" },
      idempotencyKey,
      relations:
        eventId === null ? [] : [{ kind: "resolved", relationPropertyId: sourceEvents.id, targetItemIds: [eventId] }],
    },
    {
      queueAffinity: input.queueAffinity,
      actingUserId: input.userId,
      humanWriterUserId: input.userId,
      writer: { writerKind: "user" },
    },
  );

  const ownerSpeaker = actionItem.ownerSpeaker;
  const speakers = ownerSpeaker === null ? [] : await listTranscriptSpeakers(client, transcript.id, transcript);
  await setActionItemState(client, {
    transcriptId: transcript.id,
    actionItemId: input.actionItemId,
    state: "added",
    taskItemId: task.id,
    ownerPersonId: speakers.find((entry) => entry.speaker === ownerSpeaker)?.person?.id ?? null,
  });
  return { taskId: task.id, created: replayed === null };
}

/**
 * Undoes an `added` item, in the caller's transaction, under the transcript row lock: trashes the
 * task as the user when it is live and deletes the state row, so the item is open again (`null`).
 * Any other state is left unchanged and returned, so a repeated call changes nothing.
 */
export async function removeActionItemTask(
  client: PoolClient,
  input: ActionItemTaskRequest,
): Promise<{ actionItemId: number; state: Exclude<TranscriptActionItemState, "added"> | null }> {
  const transcript = await lockLiveTranscript(client, input.transcriptId);
  const notes = transcript && parseStoredMeetingNotes(transcript.computed[TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY]);
  if (!transcript || !notes?.actionItems[input.actionItemId]) {
    throw actionItemNotFound(input.transcriptId, input.actionItemId);
  }
  const states = await listActionItemStates(client, transcript.id);
  const stored = states.find((row) => row.actionItemId === input.actionItemId);
  if (stored?.state !== "added") return { actionItemId: input.actionItemId, state: stored?.state ?? null };

  const [task] = stored.taskItemId === null ? [] : await itemsStore.getItemsByIds(client, [stored.taskItemId]);
  if (task) {
    await itemDeleteWithClient(client, task.databaseId, task.id, {
      queueAffinity: input.queueAffinity,
      actingUserId: input.userId,
      writer: { writerKind: "user" },
    });
  }
  await clearActionItemState(client, transcript.id, input.actionItemId);
  return { actionItemId: input.actionItemId, state: null };
}

export interface EventActionItemProposal {
  transcriptId: string;
  actionItemId: number;
  text: string;
  ownerSpeaker: string | null;
  ownerLabel: string | null;
  due: string | null;
  startsAt: number | null;
  state: "open";
}

/** A transcript without a readable `date` sorts last. */
function recordedAt(transcript: ItemRow): number {
  const date = transcript.properties.date;
  const at = typeof date === "string" ? Date.parse(date) : Number.NaN;
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : at;
}

/**
 * Open items that are mine or have no owner, over every live transcript linked to the Event, ordered
 * by transcript `date` (missing last, ties by id) then item id. `null` when `eventId` names no live
 * Event of the tenant in scope.
 */
export async function listEventActionItemProposals(
  client: PoolClient,
  eventId: string,
  locale: string,
): Promise<EventActionItemProposal[] | null> {
  const events = await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
  const event = events && (await itemsStore.getItemById(client, events.id, eventId));
  if (!event || event.deletedAt) return null;
  const transcripts = await getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
  const property = transcripts && (await getPropertyByKey(client, transcripts.id, "event"));
  const definition = property && (await getRelationDefinitionByPropertyId(client, property.id));
  if (!definition) return [];
  const edges = await listRelationsForItem(client, definition.id, event.id);
  const linked = await itemsStore.getItemsByIds(
    client,
    edges.map((edge) => otherSide(edge, event.id)),
  );
  linked.sort((a, b) => recordedAt(a) - recordedAt(b) || (a.id < b.id ? -1 : 1));
  const proposals: EventActionItemProposal[] = [];
  for (const transcript of linked) {
    for (const item of await listTranscriptActionItems(client, transcript.id, locale)) {
      if (item.state !== "open" || !(item.isMine || item.ownerSpeaker === null)) continue;
      const { id, text, ownerSpeaker, ownerLabel, due, startsAt, state } = item;
      proposals.push({
        transcriptId: transcript.id,
        actionItemId: id,
        text,
        ownerSpeaker,
        ownerLabel,
        due,
        startsAt,
        state,
      });
    }
  }
  return proposals;
}
