// Issue #1767: the action items of a transcript's meeting notes as a reader gets them, the task a user
// makes of one, the undo of that, and the open items an Event offers. The state of an item is a row of
// `transcript_action_item_states`; the two writers here lock the transcript's item row before they read
// it and write through `./transcriptActionItemStates.ts`.
// Constrained by: docs/adr/2026-11-11-transcript-action-item-states-serialize-on-the-transcript-row.md,
// docs/adr/2026-11-11-action-item-tasks-inherit-project-and-people-by-link-rules.md
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

/** One action item of a transcript's meeting notes, rendered for a reader, with what the user did with it. */
export interface TranscriptActionItem {
  /** The item's position in the stored `computed.meetingNotes.actionItems`. */
  id: number;
  text: string;
  ownerSpeaker: string | null;
  ownerLabel: string | null;
  due: string | null;
  startsAt: number | null;
  /** `open` for an item without a stored state and for an `added` item whose task is not live. */
  state: "open" | TranscriptActionItemState;
  /** The live task of an `added` item; `null` in every other state. */
  taskId: string | null;
  /** Whether the item's owner speaker is mapped, through a `speakers` edge, to the tenant's own person. */
  isMine: boolean;
}

/**
 * The action items of a transcript's meeting notes (issue #1767), in the order of their ids: each
 * rendered by `renderMeetingNotes` in `locale` and joined with its stored state. An item is `added`
 * only while the task its state row names is a live item: with that task in the Trash or purged the
 * item reads `open` and has no `taskId`. `isMine` is true when the item's `ownerSpeaker` is mapped to
 * the person System settings `selfPerson` names; an item without an owner, with an unmapped owner or
 * in a tenant without an own person is not mine. A transcript that does not exist in the tenant in
 * scope, one in the Trash and one without stored notes have no items.
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

/** The same error for an unknown transcript, another tenant's, one in the Trash and an action item the notes do not have. */
function actionItemNotFound(transcriptId: string, actionItemId: number): NotFoundError {
  return new NotFoundError("Transcript action item not found", {
    resource: "transcriptActionItem",
    transcriptId,
    actionItemId,
  });
}

/**
 * Locks the item row of a live transcript until the transaction ends and returns it, or `null` for an
 * id that names no transcript of the tenant in scope and for a transcript in the Trash.
 */
async function lockLiveTranscript(client: PoolClient, transcriptId: string): Promise<ItemRow | null> {
  const transcripts = await getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
  const transcript = transcripts && (await itemsStore.lockItemById(client, transcripts.id, transcriptId));
  return transcript && !transcript.deletedAt ? transcript : null;
}

/** One action item of a transcript, and the signed-in user whose write the request is. */
export interface ActionItemTaskRequest {
  transcriptId: string;
  actionItemId: number;
  userId: string;
  queueAffinity: ActionQueueAffinity;
}

/**
 * Makes a task of one action item (issue #1767) and returns its id, with `created` false when the
 * call created no item. Runs in the caller's transaction.
 *
 * It locks the transcript's item row, then reads the item and its state. An item that is `added`
 * with a live task is answered with that task and nothing is written. Otherwise it creates a Tasks
 * item as the user, through the item create with relations (issue #1590): `name` is `input.name` or
 * the item's rendered text in `input.locale`, `date` is `input.date` or the item's `due` (left out
 * when both are absent), `status` is `notDone`. The task gets a `sourceEvents` edge to the
 * transcript's live linked Event and none when the transcript has no such Event; the link rules of
 * issue #1724 fill its project and people from that edge. The create carries the idempotency key
 * `transcript-action-item:<transcriptId>:<actionItemId>`: when the item reserved under it is live
 * (a task that was undone and then restored from the Trash), that item is returned unchanged and
 * `created` is false; a reservation whose item is in the Trash or purged is released by the store
 * and a new task is created. The state row is then stored as `added` with the task and with the
 * live person the item's owner speaker is mapped to, replacing a `noted` row.
 *
 * Throws the action item's `NotFoundError` for a transcript that is unknown, another tenant's or in
 * the Trash and for an `actionItemId` the notes do not have. The Event is read without a lock: one
 * moved to the Trash before the edge is written makes the relation write throw its
 * `validation_failed`.
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
  // The seed and `tasks/tasksSourceEventsCutoverMigration.ts` give every tenant with transcripts both.
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
 * Takes back the task of one action item (issue #1767) and returns the state the item has
 * afterwards. Runs in the caller's transaction.
 *
 * It locks the transcript's item row, then reads the item's state row. For a row that is `added` it
 * moves the task the row names to the Trash as the user, through the choke point's item delete, when
 * that task is a live item, and deletes the row: the item is open again (`null`). A task that is
 * already in the Trash or purged is left as it is and the row is deleted all the same. Any other
 * row and an item without a row are left unchanged and answered with their state, so a repeated
 * call changes nothing.
 *
 * Throws the action item's `NotFoundError` for a transcript that is unknown, another tenant's or in
 * the Trash and for an `actionItemId` the notes do not have.
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

/** One open action item an Event offers as a task, as `GET /api/events/:id/transcript-action-items` returns it. */
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

/** A transcript's recording time for sorting; a transcript without a readable `date` sorts last. */
function recordedAt(transcript: ItemRow): number {
  const date = transcript.properties.date;
  const at = typeof date === "string" ? Date.parse(date) : Number.NaN;
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : at;
}

/**
 * The action items an Event offers as tasks (issue #1767): over every live transcript linked to the
 * Event through the Transcripts `event` relation, the items `listTranscriptActionItems` reads as
 * `open` that are mine or have no owner. An item with a live task, a followed item and an item owned
 * by anyone else, an unmapped speaker included, are left out. Ordered by the transcript's `date`
 * ascending (a transcript without one last, equal dates by transcript id), then by the item's id.
 * Returns `null` when `eventId` names no live Event of the tenant in scope: an unknown id, another
 * tenant's Event, an Event in the Trash and a tenant without an Events database alike.
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
