import type { PoolClient } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { requireAffectedRows, requireSingleRow } from "../db/pool.js";
import { assertKnownValue } from "../dbRowValidation.js";
import { NotFoundError } from "../errors.js";
import { TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

/**
 * The `transcript_action_item_states` store (issue #1754): what the user did with one action item of
 * a transcript's meeting notes. A row is keyed by the transcript and the item's position in the
 * stored `computed.meetingNotes.actionItems` array; an open item has no row. The reads and the delete
 * filter by `app_tenant_default()` and the insert takes `tenant_id` from the column default, so every
 * statement stays in the tenant in scope. The transcript row lock the writers take is recorded in
 * `docs/adr/2026-11-11-transcript-action-item-states-serialize-on-the-transcript-row.md`.
 */

const ACTION_ITEM_STATES = ["added", "noted", "dismissed"] as const;

export type TranscriptActionItemState = (typeof ACTION_ITEM_STATES)[number];

export interface TranscriptActionItemStateRow {
  actionItemId: number;
  state: TranscriptActionItemState;
  taskItemId: string | null;
  ownerPersonId: string | null;
  updatedAt: string;
}

export interface SetActionItemStateInput {
  transcriptId: string;
  actionItemId: number;
  state: TranscriptActionItemState;
  taskItemId: string | null;
  ownerPersonId: string | null;
}

const STATE_COLUMNS = "action_item_id, state, task_item_id, owner_person_id, updated_at";

interface ActionItemStateDbRow {
  action_item_id: number;
  state: string;
  task_item_id: string | null;
  owner_person_id: string | null;
  updated_at: Date;
}

function toStateRow(row: ActionItemStateDbRow): TranscriptActionItemStateRow {
  return {
    actionItemId: row.action_item_id,
    state: assertKnownValue(ACTION_ITEM_STATES, row.state, "transcript_action_item_states.state"),
    taskItemId: row.task_item_id,
    ownerPersonId: row.owner_person_id,
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Locks the transcript's item row until the transaction ends. Both writers below take this lock
 * before their statement, so two transactions writing states of one transcript run one after the
 * other, and a writer that waited for a permanent purge of the transcript finds no row and is
 * refused. A transcript in the Trash is locked like a live one.
 */
async function lockTranscript(client: PoolClient, transcriptId: string): Promise<void> {
  const transcripts = await getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
  const transcript = transcripts && (await itemsStore.lockItemById(client, transcripts.id, transcriptId));
  if (!transcript) {
    throw new NotFoundError(`Transcripts item '${transcriptId}' not found`, { resource: "item", itemId: transcriptId });
  }
}

/** The stored states of a transcript's action items, ordered by action item id. An open item is absent. */
export async function listActionItemStates(
  client: PoolClient,
  transcriptId: string,
): Promise<TranscriptActionItemStateRow[]> {
  const { rows } = await client.query<ActionItemStateDbRow>(
    `SELECT ${STATE_COLUMNS} FROM transcript_action_item_states
      WHERE tenant_id = app_tenant_default() AND transcript_item_id = $1
      ORDER BY action_item_id`,
    [transcriptId],
  );
  return rows.map(toStateRow);
}

/**
 * Stores the state of one action item and returns the row as stored. A row that already holds
 * exactly `input`'s state, task and owner is left untouched, `updated_at` included; any other row of
 * the item is overwritten. Throws `NotFoundError` when the transcript's item row does not exist. It
 * does not check that the transcript has an action item at `actionItemId`: the caller does.
 */
export async function setActionItemState(
  client: PoolClient,
  input: SetActionItemStateInput,
): Promise<TranscriptActionItemStateRow> {
  await lockTranscript(client, input.transcriptId);
  const written = await client.query<ActionItemStateDbRow>(
    `INSERT INTO transcript_action_item_states AS stored
       (transcript_item_id, action_item_id, state, task_item_id, owner_person_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, transcript_item_id, action_item_id) DO UPDATE
       SET state = EXCLUDED.state, task_item_id = EXCLUDED.task_item_id,
           owner_person_id = EXCLUDED.owner_person_id, updated_at = now()
       WHERE (stored.state, stored.task_item_id, stored.owner_person_id)
             IS DISTINCT FROM (EXCLUDED.state, EXCLUDED.task_item_id, EXCLUDED.owner_person_id)
     RETURNING ${STATE_COLUMNS}`,
    [input.transcriptId, input.actionItemId, input.state, input.taskItemId, input.ownerPersonId],
  );
  if (written.rows[0]) return toStateRow(written.rows[0]);
  // The conflicting row already held these values, so the statement wrote and returned nothing.
  const unchanged = await client.query<ActionItemStateDbRow>(
    `SELECT ${STATE_COLUMNS} FROM transcript_action_item_states
      WHERE tenant_id = app_tenant_default() AND transcript_item_id = $1 AND action_item_id = $2`,
    [input.transcriptId, input.actionItemId],
  );
  return toStateRow(requireSingleRow(unchanged.rows, "transcript action item state left unchanged by its upsert"));
}

/**
 * Deletes the state row of one action item, which makes the item open again. The row must exist;
 * the route reads it under the transcript lock before it clears it. Throws `NotFoundError` when the
 * transcript's item row does not exist, and a plain `Error` when the item has no state row.
 */
export async function clearActionItemState(
  client: PoolClient,
  transcriptId: string,
  actionItemId: number,
): Promise<void> {
  await lockTranscript(client, transcriptId);
  const result = await client.query(
    `DELETE FROM transcript_action_item_states
      WHERE tenant_id = app_tenant_default() AND transcript_item_id = $1 AND action_item_id = $2`,
    [transcriptId, actionItemId],
  );
  requireAffectedRows(result, `state of action item ${actionItemId} of transcript '${transcriptId}'`);
}
