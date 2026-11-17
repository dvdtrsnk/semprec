import type { PoolClient } from "pg";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { createRelationIfAbsentWithClient } from "../chokePoint/relationOps.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { NotFoundError } from "../errors.js";
import { getSelfPersonId } from "../selfPerson.js";
import { EVENTS_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { listTranscriptSpeakers } from "./transcriptionSpeakerEdges.js";

export interface AddedParticipantEdge {
  edgeId: string;
  relationPropertyId: string;
  callerItemId: string;
  targetItemId: string;
}

/**
 * Adds the people the transcript's `speakers` edges map now to the Event's `people`, in the caller's
 * transaction. The tenant's own person and existing participants are skipped; nothing is removed.
 * Returns the inserted edges in person id order.
 *
 * The transcript row is locked before reading `speakers` edges, the lock every `speakers` writer
 * takes: a manual assignment either commits before this read, or waits and then finds the `event`
 * edge and adds the person itself. The caller already holds the card's lock, so the order stays card,
 * then transcript.
 *
 * People are written in id order because each edge queues a last-contact recompute under a job key a
 * second transaction waits for; two confirms sharing people would otherwise deadlock.
 */
export async function addSpeakersAsEventParticipants(
  client: PoolClient,
  input: { transcriptId: string; eventId: string },
  writer: WriterIdentity,
  actingUserId?: string,
): Promise<AddedParticipantEdge[]> {
  const transcriptsDatabase = await databasesStore.getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
  if (!transcriptsDatabase) throw new NotFoundError(`Database for module '${TRANSCRIPTS_MODULE_ID}' not found`);
  const transcript = await itemsStore.lockItemById(client, transcriptsDatabase.id, input.transcriptId);
  if (!transcript) {
    throw new NotFoundError(`Transcripts item '${input.transcriptId}' not found`, {
      resource: "item",
      itemId: input.transcriptId,
    });
  }
  const selfPersonId = await getSelfPersonId(client);
  const mappedPersonIds = (await listTranscriptSpeakers(client, input.transcriptId)).flatMap((speaker) =>
    speaker.person && speaker.person.id !== selfPersonId ? [speaker.person.id] : [],
  );
  const personIds = [...new Set(mappedPersonIds)].sort();
  if (personIds.length === 0) return [];

  const eventsDatabase = await databasesStore.getDatabaseByModuleId(client, EVENTS_MODULE_ID);
  if (!eventsDatabase) throw new NotFoundError(`Database for module '${EVENTS_MODULE_ID}' not found`);
  const peopleProperty = await propertiesStore.getPropertyByKey(client, eventsDatabase.id, "people");
  if (!peopleProperty) throw new NotFoundError(`Property 'people' not found on database ${eventsDatabase.id}`);

  const added: AddedParticipantEdge[] = [];
  for (const personId of personIds) {
    const result = await createRelationIfAbsentWithClient(
      client,
      { relationPropertyId: peopleProperty.id, callerItemId: input.eventId, targetItemId: personId },
      undefined,
      writer,
      actingUserId,
    );
    if (result.inserted) {
      added.push({
        edgeId: result.edge.id,
        relationPropertyId: peopleProperty.id,
        callerItemId: input.eventId,
        targetItemId: personId,
      });
    }
  }
  return added;
}
