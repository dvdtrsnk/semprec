// Write hooks keeping People `lastContact` current. Each only queues the recompute inside the triggering write's
// transaction, so the job commits or rolls back with it; the recompute reads committed sources later.
import type { ItemDeleteHook, ItemRestoreHook, ItemUpdateHook, RelationEdgeChangedHook } from "../chokePoint/hooks.js";
import type { DatabaseRow } from "../types.js";
import { EMAILS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { EVENTS_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import {
  enqueueLinkedPeopleLastContactRecompute,
  enqueuePersonLastContactRecompute,
  findLastContactSourceRelation,
} from "./lastContact.js";

const SOURCE_MODULE_IDS: ReadonlySet<string> = new Set([EVENTS_MODULE_ID, EMAILS_MODULE_ID, TRANSCRIPTS_MODULE_ID]);

function isSourceDatabase(database: DatabaseRow): boolean {
  return database.system && database.ownerModuleId !== null && SOURCE_MODULE_IDS.has(database.ownerModuleId);
}

/** Enqueues the person on the People side of a source relation edge that was written or deleted. */
export const peopleLastContactEdgeChangedHook: RelationEdgeChangedHook = async (context) => {
  const relation = await findLastContactSourceRelation(context.client, context.relationDefinitionId);
  if (!relation) return;
  await enqueuePersonLastContactRecompute(context.client, relation.personSide === "b" ? context.itemB : context.itemA);
};

/** An Event's start is its date-only `date` plus `timeFrom`, so `timeFrom` counts for Events. */
export const peopleLastContactItemUpdateHook: ItemUpdateHook = async ({ client, database, item, propertiesPatch }) => {
  if (!isSourceDatabase(database)) return;
  const datePatched =
    Object.hasOwn(propertiesPatch, "date") ||
    (database.ownerModuleId === EVENTS_MODULE_ID && Object.hasOwn(propertiesPatch, "timeFrom"));
  if (!datePatched) return;
  await enqueueLinkedPeopleLastContactRecompute(client, item.id);
};

export const peopleLastContactItemDeleteHook: ItemDeleteHook = async ({ client, database, item }) => {
  if (!isSourceDatabase(database)) return;
  await enqueueLinkedPeopleLastContactRecompute(client, item.id);
};

export const peopleLastContactItemRestoreHook: ItemRestoreHook = async ({ client, database, item }) => {
  if (!isSourceDatabase(database)) return;
  await enqueueLinkedPeopleLastContactRecompute(client, item.id);
};
