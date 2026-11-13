import { DatabaseError, type PoolClient } from "pg";
import { z } from "zod";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemById, lockItemByIdNowait } from "../chokePoint/itemsStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import {
  getRelationDefinitionByPropertyId,
  listRelationsForItem,
  otherSide,
  tryLockRelationDefinition,
} from "../chokePoint/relationsStore.js";
import { markManagedTransactionRollbackOnly, requireAffectedRows, requireManagedTransaction } from "../db/pool.js";
import { ChokePointError, NotFoundError } from "../errors.js";
import { EVENTS_MODULE_ID, FILES_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { TRANSCRIPTION_CREATE_COMPUTED_KEY } from "./transcriptionComputedKeys.js";
import {
  enqueueTranscriptionCreate,
  enqueueTranscriptionJob,
  findTranscriptionCreateJobId,
  findTranscriptionJobId,
  readTranscriptionSourceFileItemId,
  TRANSCRIPTION_OWNER_PROCESS,
} from "./transcriptionJob.js";

const requestRow = z
  .object({
    event_item_id: z.uuid().nullable(),
    recorded_at: z.string().nullable(),
    name: z.string().nullable(),
    language: z
      .string()
      .regex(/^[a-z]{2}$/)
      .nullable(),
    num_speakers_exact: z.number().int().positive().nullable(),
    num_speakers_min: z.number().int().positive().nullable(),
    project_item_id: z.uuid().nullable(),
  })
  .refine((row) => row.num_speakers_exact === null || row.num_speakers_min === null);
export async function readRecordingRequest(client: PoolClient, fileItemId: string) {
  const result = await client.query<Record<string, unknown>>(
    `SELECT event_item_id, to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_at,
            name, language, num_speakers_exact, num_speakers_min, project_item_id
     FROM recording_requests WHERE tenant_id = app_tenant_default() AND file_item_id = $1`,
    [fileItemId],
  );
  if (!result.rows[0]) return null;
  const row = requestRow.parse(result.rows[0]);
  return {
    eventId: row.event_item_id,
    recordedAt: row.recorded_at,
    name: row.name,
    language: row.language,
    numSpeakersExact: row.num_speakers_exact,
    numSpeakersMin: row.num_speakers_min,
    projectItemId: row.project_item_id,
  };
}

function recordingBusy() {
  return new ChokePointError(409, "recording_busy", "Recording is busy");
}
async function reserve<T>(client: PoolClient, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "55P03") {
      const busy = recordingBusy();
      markManagedTransactionRollbackOnly(client, busy);
      throw busy;
    }
    throw error;
  }
}

export async function recordRecordingIntake(
  client: PoolClient,
  input: { fileItemId: string; eventId: string | null; recordedAt: string | null },
) {
  requireManagedTransaction(client);
  try {
    const files = await getDatabaseByModuleId(client, FILES_MODULE_ID);
    const transcripts = await getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
    const events = await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
    if (!files || !transcripts || !events) throw new Error("Recording catalog is missing");
    const file = await reserve(client, () => lockItemByIdNowait(client, files.id, input.fileItemId));
    if (!file || file.deletedAt) throw new NotFoundError("File not found");
    const checkpoint = file.computed[TRANSCRIPTION_CREATE_COMPUTED_KEY];
    const transcriptId = checkpoint === undefined ? null : z.uuid().parse(checkpoint);
    const transcript = transcriptId
      ? await reserve(client, () => lockItemByIdNowait(client, transcripts.id, transcriptId))
      : null;
    if (transcriptId && !transcript) throw new NotFoundError("Transcript not found");
    if (transcript && readTranscriptionSourceFileItemId(transcript.properties.link) !== file.id)
      throw new Error("Recording transcript binding is invalid");
    const rechecked = await reserve(client, () => lockItemByIdNowait(client, files.id, file.id));
    if (!rechecked || rechecked.deletedAt || rechecked.computed[TRANSCRIPTION_CREATE_COMPUTED_KEY] !== checkpoint)
      throw new Error("Recording file binding changed");
    const property = await getPropertyByKey(client, transcripts.id, "event");
    const definition = property && (await getRelationDefinitionByPropertyId(client, property.id));
    if (!property || !definition) throw new Error("Transcript event relation is missing");
    const edges = transcriptId ? await listRelationsForItem(client, definition.id, transcriptId) : [];
    if (edges.length > 1) throw new Error("Transcript has multiple event edges");
    const existingEventId = transcriptId && edges[0] ? otherSide(edges[0], transcriptId) : null;
    const oldRequest = await readRecordingRequest(client, file.id);
    const ids = [
      ...new Set([input.eventId, existingEventId, oldRequest?.eventId].filter((id): id is string => !!id)),
    ].sort();
    const eventRows = new Map<string, Awaited<ReturnType<typeof getItemById>>>();
    for (const id of ids) eventRows.set(id, await reserve(client, () => lockItemByIdNowait(client, events.id, id)));
    if (input.eventId && !eventRows.get(input.eventId)) throw new NotFoundError("Event not found");
    if (
      (existingEventId && !eventRows.get(existingEventId)) ||
      (oldRequest?.eventId && !eventRows.get(oldRequest.eventId))
    )
      throw new Error("Recording event reference is missing");
    const requested = input.eventId && !eventRows.get(input.eventId)?.deletedAt ? input.eventId : null;
    if (
      requested &&
      ((oldRequest?.eventId && oldRequest.eventId !== requested) || (existingEventId && existingEventId !== requested))
    ) {
      throw new ChokePointError(409, "recording_linked_elsewhere", "Recording is linked elsewhere", {
        transcriptId,
        eventId: existingEventId ?? oldRequest?.eventId ?? null,
      });
    }
    await client.query(
      `INSERT INTO recording_requests (file_item_id, event_item_id, recorded_at) VALUES ($1, $2, $3::timestamptz) ON CONFLICT (tenant_id, file_item_id) DO NOTHING`,
      [file.id, requested, input.recordedAt],
    );
    const request = await readRecordingRequest(client, file.id);
    if (!request) throw new Error("Recording request disappeared");
    if (!request.eventId && requested) {
      const result = await client.query(
        "UPDATE recording_requests SET event_item_id = $2 WHERE tenant_id = app_tenant_default() AND file_item_id = $1 AND event_item_id IS NULL",
        [file.id, requested],
      );
      requireAffectedRows(result, "recording event claim");
    }
    if (requested && transcriptId && transcript && !transcript.deletedAt && !existingEventId) {
      if (!(await tryLockRelationDefinition(client, definition.id))) throw recordingBusy();
      await createRelationWithClient(
        client,
        { relationPropertyId: property.id, callerItemId: transcriptId, targetItemId: requested },
        { ownerProcess: TRANSCRIPTION_OWNER_PROCESS },
      );
    }
    if (!transcriptId) {
      if (!(await findTranscriptionCreateJobId(client, file.id)))
        await enqueueTranscriptionCreate(client, { fileItemId: file.id });
      if (!(await findTranscriptionJobId(client, file.id)))
        await enqueueTranscriptionJob(client, { fileItemId: file.id });
    }
    const association = existingEventId ?? request.eventId ?? requested;
    return {
      transcriptId,
      eventId: association && !eventRows.get(association)?.deletedAt && eventRows.get(association) ? association : null,
    };
  } catch (error) {
    markManagedTransactionRollbackOnly(client, error);
    throw error;
  }
}

export async function deleteRecordingRequestForFile(client: PoolClient, fileItemId: string): Promise<void> {
  const deleted = await client.query(
    "DELETE FROM recording_requests WHERE tenant_id = app_tenant_default() AND file_item_id = $1",
    [fileItemId],
  );
  if (deleted.rowCount === null || deleted.rowCount > 1) throw new Error("Unexpected recording request deletion count");
}
