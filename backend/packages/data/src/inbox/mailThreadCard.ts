import type { PoolClient } from "pg";
import { z } from "zod";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { lockItemById } from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { THREADS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { DatabaseRow, ItemRow } from "../types.js";
import { THREAD_TASK_NAME_MAX_LENGTH, createThreadTask } from "../mail/threadTasks.js";
import { assertValidProposalEnvelope } from "./inboxTickAction.js";
import type { ProposalEnvelope } from "./proposalEnvelope.js";

/**
 * Kept out of `proposalActions.ts` for the ESLint line cap. The envelope carries only the task's `name` and optional
 * `date`; project and people come from the thread at confirm (`createThreadTask`).
 */
export const MAIL_THREAD_CARD_KIND = "mailThread";

const SOURCE_THREAD_PROPERTY_KEY = "sourceThread";

/** Bounds match the task creation route. */
const threadTaskCardPropertiesSchema = z.strictObject({
  name: z.string().min(1).max(THREAD_TASK_NAME_MAX_LENGTH),
  date: z.iso.date().optional(),
});

/**
 * Runs before the generic envelope validation so the answer names the card's own rule; each refusal is a
 * `ValidationError` whose `details.field` names the wrong part. Even an empty `relations` object is refused.
 */
async function assertMailThreadCardEnvelope(client: PoolClient, envelope: ProposalEnvelope): Promise<void> {
  if (envelope.entityKind !== "database")
    throw new ValidationError("A thread task proposal must be a database proposal", { field: "entityKind" });
  if (envelope.operations !== undefined)
    throw new ValidationError("A thread task proposal has no steps", { field: "operations" });
  if (envelope.relations !== undefined)
    throw new ValidationError("A thread task proposal has no relations", { field: "relations" });
  const tasks = await databasesStore.getDatabaseByModuleId(client, TASKS_MODULE_ID);
  if (!tasks || envelope.target !== tasks.id)
    throw new ValidationError("A thread task proposal must target the Tasks database", { field: "target" });
  if (!threadTaskCardPropertiesSchema.safeParse(envelope.properties).success)
    throw new ValidationError("A thread task proposal carries a name of 1 to 500 characters and an optional date", {
      field: "properties",
    });
}

/**
 * A missing edge is a `ValidationError` on `sourceThread`, including a purged thread (the purge removes every edge). A
 * trashed thread passes; confirm answers 409 for it.
 */
async function requireSourceThreadItemId(
  client: PoolClient,
  processingProposalsDatabaseId: string,
  card: ItemRow,
): Promise<string> {
  const property = await propertiesStore.getPropertyByKey(
    client,
    processingProposalsDatabaseId,
    SOURCE_THREAD_PROPERTY_KEY,
  );
  if (!property) throw new NotFoundError(`Property '${SOURCE_THREAD_PROPERTY_KEY}' not found on Processing proposals`);
  const definition = await relationsStore.getRelationDefinitionByPropertyId(client, property.id);
  if (!definition)
    throw new NotFoundError(`Relation definition for Processing proposals '${SOURCE_THREAD_PROPERTY_KEY}' not found`);
  const [edge] = await relationsStore.listRelationsForItem(client, definition.id, card.id);
  if (!edge)
    throw new ValidationError(`Thread task proposal ${card.id} has no source thread`, {
      field: SOURCE_THREAD_PROPERTY_KEY,
    });
  return relationsStore.otherSide(edge, card.id);
}

/** Assignable to `EnvelopeForCard` of `proposalActions.ts`. */
export interface MailThreadCardValidation {
  transcriptCardEdge: null;
  targetDatabase: DatabaseRow | null;
  mailThreadItemId: string;
}

/** Card rules, then the generic envelope validation, then the `sourceThread` edge; throws the first failure. */
export async function assertValidMailThreadCard(
  client: PoolClient,
  config: { processingProposalsDatabaseId: string },
  card: ItemRow,
  envelope: ProposalEnvelope,
): Promise<MailThreadCardValidation> {
  await assertMailThreadCardEnvelope(client, envelope);
  const targetDatabase = await assertValidProposalEnvelope(client, envelope);
  const mailThreadItemId = await requireSourceThreadItemId(client, config.processingProposalsDatabaseId, card);
  return { transcriptCardEdge: null, targetDatabase, mailThreadItemId };
}

/** Confirming is a person's decision, so the task is a `user` write. */
const CONFIRMING_USER_WRITER: WriterIdentity = { writerKind: "user" };

/**
 * Locks the Threads item first; a trashed thread, or one purged after the edge was read, is a 409 with nothing
 * written and the card stays `proposed`. Properties are parsed again here.
 */
export async function confirmMailThreadCard(
  client: PoolClient,
  threadItemId: string,
  properties: Record<string, unknown>,
  actingUserId?: string,
): Promise<ItemRow> {
  const { name, date } = threadTaskCardPropertiesSchema.parse(properties);
  const threads = await databasesStore.getDatabaseByModuleId(client, THREADS_MODULE_ID);
  if (!threads) throw new Error("The Threads database is not seeded");
  const thread = await lockItemById(client, threads.id, threadItemId);
  if (!thread || thread.deletedAt)
    throw new ConflictError("The thread of this proposal no longer exists", { field: "sourceThread" }, "conflict");
  return createThreadTask(client, { threadItemId, name, date }, { writer: CONFIRMING_USER_WRITER, actingUserId });
}
