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

/** An Events `people` edge written by `addSpeakersAsEventParticipants`. */
export interface AddedParticipantEdge {
  edgeId: string;
  relationPropertyId: string;
  callerItemId: string;
  targetItemId: string;
}

/**
 * Adds the people the transcript's `speakers` edges map at this moment to the Event's `people`, in the
 * caller's transaction (issue #1818). The tenant's own person (`getSelfPersonId`) is not added, an
 * unmapped speaker adds nobody, a person who already is a participant is left as they are, and a person
 * mapped to two speakers is added once. Nothing is ever removed. Returns the edges this call inserted,
 * in person id order. A failing edge write propagates and rolls the caller back.
 *
 * The transcript's row is locked before the `speakers` edges are read, the lock every `speakers` edge
 * writer takes (`assertSpeakerEdgeWritable`). A manual assignment that holds it therefore commits before
 * this read, so its person is read here, or it waits for the caller's commit and finds the transcript's
 * `event` edge, which makes it add the person itself (docs/adr/2026-11-12-a-manual-speaker-assignment-settles-the-key-card-in-the-confirm-lock-order.md).
 * The caller holds the card's lock by then, so the order stays card, then transcript.
 *
 * The people are written in id order. Each `people` edge queues the person's last-contact recompute under
 * a job key that a second transaction queuing the same key waits for, so two confirms that share people
 * must take those keys in one order or they can deadlock.
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
