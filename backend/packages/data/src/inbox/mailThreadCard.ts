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
 * The card of a task that Semp proposes from a mail thread (issue gh-2034), split out of `proposalActions.ts` to keep
 * that file under the ESLint line cap. The card's stored `kind` is `mailThread`; it is linked to the thread's Threads
 * item through the Processing proposals relation `sourceThread`, and its envelope is a `database` envelope for Tasks
 * that carries only the task's `name` and an optional `date`. The task's project and people are not on the card: they
 * come from the thread when the card is confirmed (`createThreadTask`).
 */
export const MAIL_THREAD_CARD_KIND = "mailThread";

/** The Processing proposals relation from a `mailThread` card to the Threads item it was made for. */
const SOURCE_THREAD_PROPERTY_KEY = "sourceThread";

/** The only properties of a `mailThread` card's envelope; the bounds are those of the task creation route. */
const threadTaskCardPropertiesSchema = z.strictObject({
  name: z.string().min(1).max(THREAD_TASK_NAME_MAX_LENGTH),
  date: z.iso.date().optional(),
});

/**
 * Refuses an envelope that is not a Tasks `database` envelope with `{ name, date? }` as its properties, each with a
 * `ValidationError` naming the part of the envelope that is wrong as `details.field`: another entity kind
 * (`entityKind`), a multi-step `operations` list, a `relations` entry (`relations`, even an empty object), another
 * target than the Tasks database (`target`), and a property other than `name` and `date` or a value that is not valid
 * for them (`properties`). `assertValidMailThreadCard` runs it before the generic envelope validation, so that the answer
 * names the card's own rule.
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
 * The Threads item a `mailThread` card was made for: the other side of its `sourceThread` edge. A card without that
 * edge is a `ValidationError` on `sourceThread`; that includes a card whose thread was purged, because the purge removes
 * every edge of the item. The item may be in the Trash; confirm decides that (409).
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

/** What `assertValidMailThreadCard` resolved; assignable to `EnvelopeForCard` of `proposalActions.ts`. */
export interface MailThreadCardValidation {
  transcriptCardEdge: null;
  targetDatabase: DatabaseRow | null;
  /** The Threads item of the card's `sourceThread` edge. */
  mailThreadItemId: string;
}

/**
 * Validates `envelope` against the `mailThread` card `card`, for confirm and for every revise: the card's own rules
 * (`assertMailThreadCardEnvelope`), then the generic envelope validation, then the card's `sourceThread` edge (a
 * `ValidationError` on `sourceThread` when it has none). Throws the first of them that fails.
 */
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

/** Confirming a proposal is a person's decision, so the task is written as a `user` write (as `proposalActions.ts` does). */
const CONFIRMING_USER_WRITER: WriterIdentity = { writerKind: "user" };

/**
 * The confirm of a `mailThread` card, in the caller's transaction: the task of `createThreadTask` for the Threads item
 * `threadItemId`, named and dated by `properties` (the envelope's, already validated by `assertValidMailThreadCard`
 * and parsed again here), written as a user write for `actingUserId`. The Threads item is locked first; one in the Trash,
 * or one whose row the lock no longer finds (purged after the card's edge was read), is a 409 `conflict` with nothing
 * written, and the card stays `proposed`. A thread purged before the confirm began has no edge left, so the card never
 * gets here: `requireSourceThreadItemId` answers the `sourceThread` validation error. Returns the new Tasks item.
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
