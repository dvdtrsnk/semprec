// Issue #1660: the write hooks that keep People `lastContact` current. Each runs inside the triggering
// write's transaction and only queues `peopleLastContactRecompute` for the affected people there, so the
// job commits or rolls back with the write; the recompute itself reads the committed sources later.
// Registered in `../domainWriteHooks.ts` (docs/adr/2026-09-30-choke-point-domain-hooks-through-a-per-process-registry.md,
// docs/adr/2026-11-07-item-delete-and-restore-domain-hooks.md).
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

/**
 * After an `Events.people`, `Emails.senderPeople`, `Emails.recipientsPeople` or `Transcripts.speakers`
 * edge is written or deleted (issue #1530's hook): the person on its People side.
 */
export const peopleLastContactEdgeChangedHook: RelationEdgeChangedHook = async (context) => {
  const relation = await findLastContactSourceRelation(context.client, context.relationDefinitionId);
  if (!relation) return;
  await enqueuePersonLastContactRecompute(context.client, relation.personSide === "b" ? context.itemB : context.itemA);
};

/**
 * An update of an Event, Email or Transcript whose stored patch writes `date`, or, for an Event, its
 * start `timeFrom` (since issue #1598 an Event's start is its date-only `date` plus `timeFrom`): every
 * person linked to that item.
 */
export const peopleLastContactItemUpdateHook: ItemUpdateHook = async ({ client, database, item, propertiesPatch }) => {
  if (!isSourceDatabase(database)) return;
  const datePatched =
    Object.hasOwn(propertiesPatch, "date") ||
    (database.ownerModuleId === EVENTS_MODULE_ID && Object.hasOwn(propertiesPatch, "timeFrom"));
  if (!datePatched) return;
  await enqueueLinkedPeopleLastContactRecompute(client, item.id);
};

/** An Event, Email or Transcript the trash cascade actually trashed: every person linked to it. */
export const peopleLastContactItemDeleteHook: ItemDeleteHook = async ({ client, database, item }) => {
  if (!isSourceDatabase(database)) return;
  await enqueueLinkedPeopleLastContactRecompute(client, item.id);
};

/** An Event, Email or Transcript the restore cascade actually restored: every person linked to it. */
export const peopleLastContactItemRestoreHook: ItemRestoreHook = async ({ client, database, item }) => {
  if (!isSourceDatabase(database)) return;
  await enqueueLinkedPeopleLastContactRecompute(client, item.id);
};
