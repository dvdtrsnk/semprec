// Issue gh-1923: the people of a task made from a mail thread follow the conversation. A person who is linked to a
// message of the thread after the task was made is added to the task's people, while the task's people are still the
// inherited value `createThreadTask` wrote. `threadTaskPeopleEdgeChangedHook` only queues the job `mailSyncThreadTaskPeople`
// in the transaction of the edge write; `syncThreadTaskPeople` does the work later, task by task, under the task's row lock.
// Only additions are followed: removing an edge never removes a person from a task.
// Constrained by: docs/adr/2026-11-14-a-task-made-from-a-mail-thread-inherits-its-project-and-people.md,
// docs/adr/2026-11-14-thread-task-people-follow-the-conversation-by-additions-under-the-task-lock.md,
// docs/adr/2026-11-12-module-queue-tasks-read-their-composition-root-dependencies-from-a-binding.md,
// docs/adr/2026-09-30-choke-point-domain-hooks-through-a-per-process-registry.md
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { enqueueJob } from "@semprec/queue";
import { currentTenantScope, TenantScopeMissingError } from "@semprec/shared";
import type { RelationEdgeChangedHook } from "../chokePoint/hooks.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemById, lockItemById } from "../chokePoint/itemsStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { listValueLinkSourcesByLinkIds, lockValueLink } from "../chokePoint/valueLinksStore.js";
import { VALUE_LINKS_OWNER_PROCESS } from "../chokePoint/valueLinkWrites.js";
import { runAfterCommit, withTransaction } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";
import { EMAILS_MODULE_ID, THREADS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { tenantLane } from "../tenancy/tenantLane.js";
import { listConversationPersonIds, THREAD_TASK_PEOPLE_RULE_KEY } from "./threadTasks.js";

/** The queue name of the task, as `mailModuleManifest.ts` declares it. */
export const MAIL_SYNC_THREAD_TASK_PEOPLE_TASK = "mailSyncThreadTaskPeople";

/** The Emails properties whose edges carry the people of a message: the sender and the recipients. */
const MESSAGE_PEOPLE_PROPERTY_KEYS: readonly string[] = ["senderPeople", "recipientsPeople"];

const THREAD_TASK_PEOPLE_LANE = "mail-thread-task-people";

/** The payload of the task: the thread's Threads item and the person who joined its conversation. */
export const mailSyncThreadTaskPeoplePayloadSchema = z.strictObject({ threadItemId: z.uuid(), personId: z.uuid() });

export type MailSyncThreadTaskPeoplePayload = z.infer<typeof mailSyncThreadTaskPeoplePayloadSchema>;

const threadItemRow = z.object({ item_id: z.uuid().nullable() });
const mailThreadRow = z.object({ id: z.uuid() });

/**
 * The relation definition `$1`, when its side A is `Emails.senderPeople` or `Emails.recipientsPeople` (`$3`) of the
 * system Emails database (`$2`); no row for any other relation. Both properties are seeded one-directional with the
 * Emails property as side A (`seed/seedEmailModule.ts`), so item A of an edge is the message and item B the person.
 * Fixed SQL, confined to the current tenant.
 */
const MESSAGE_PEOPLE_RELATION_SQL = `
SELECT rd.id
FROM relation_definitions rd
JOIN properties p ON p.tenant_id = rd.tenant_id AND p.id = rd.property_id_a
JOIN databases d ON d.tenant_id = p.tenant_id AND d.id = p.database_id AND d.system AND d.owner_module_id = $2
WHERE rd.tenant_id = app_tenant_default() AND rd.id = $1 AND p.key = ANY($3::text[])`;

/** The Threads item of the thread the message `$1` (an Emails item) belongs to; no row for a message without a thread. */
const MESSAGE_THREAD_ITEM_SQL = `
SELECT t.item_id
FROM mail_message_meta m
JOIN mail_threads t ON t.tenant_id = m.tenant_id AND t.id = m.thread_id
WHERE m.tenant_id = app_tenant_default() AND m.item_id = $1`;

/** The `mail_threads` row of the Threads item `$1`; no row once the thread is gone. */
const MAIL_THREAD_OF_ITEM_SQL = "SELECT id FROM mail_threads WHERE tenant_id = app_tenant_default() AND item_id = $1";

/**
 * `mailSyncThreadTaskPeople:<tenantId>:<threadItemId>:<personId>`. The queue's job key is global, so the tenant of the
 * producer's scope is part of it; the person is part of it because two people who join one thread need two jobs, and a
 * repeat for the same person collapses onto the queued one.
 */
function threadTaskPeopleJobKey(tenantId: string, payload: MailSyncThreadTaskPeoplePayload): string {
  return `${MAIL_SYNC_THREAD_TASK_PEOPLE_TASK}:${tenantId}:${payload.threadItemId}:${payload.personId}`;
}

/**
 * Queues the job for one person who joined one thread, in the caller's open transaction, so the job exists only when
 * that transaction commits. The tenant comes from the producer's scope; without a tenant scope it throws and rolls the
 * caller back.
 */
async function enqueueThreadTaskPeopleSync(
  client: PoolClient,
  payload: MailSyncThreadTaskPeoplePayload,
): Promise<void> {
  const scope = currentTenantScope();
  if (scope?.kind !== "tenant") {
    throw new TenantScopeMissingError("Syncing the people of a thread's tasks requires a tenant scope");
  }
  await enqueueJob(client, MAIL_SYNC_THREAD_TASK_PEOPLE_TASK, mailSyncThreadTaskPeoplePayloadSchema.parse(payload), {
    jobKey: threadTaskPeopleJobKey(scope.tenantId, payload),
    maxAttempts: 3,
    queueName: tenantLane(THREAD_TASK_PEOPLE_LANE),
  });
}

/**
 * The relation edge changed hook of issue gh-1923. After an edge of `Emails.senderPeople` or `Emails.recipientsPeople` is
 * written with `op` `create`, it queues one
 * `mailSyncThreadTaskPeople` job for the Threads item of the message's thread and the person. It does nothing for an
 * `update` or a `delete` of the edge, for an edge of any other relation, and for a message that has no thread yet. A
 * repeated write of an existing edge also has `op` `create` and queues the same job under the same key; the job is
 * idempotent.
 */
export const threadTaskPeopleEdgeChangedHook: RelationEdgeChangedHook = async (context) => {
  if (context.op !== "create") return;
  const { client } = context;
  const { rows } = await client.query<Record<string, unknown>>(MESSAGE_PEOPLE_RELATION_SQL, [
    context.relationDefinitionId,
    EMAILS_MODULE_ID,
    MESSAGE_PEOPLE_PROPERTY_KEYS,
  ]);
  if (!rows[0]) return;
  const thread = await client.query<Record<string, unknown>>(MESSAGE_THREAD_ITEM_SQL, [context.itemA]);
  const threadItemId = thread.rows[0] ? threadItemRow.parse(thread.rows[0]).item_id : null;
  if (threadItemId === null) return;
  await enqueueThreadTaskPeopleSync(client, { threadItemId, personId: context.itemB });
};

/**
 * Adds one person to the people of the tasks of one thread, in one transaction of the job's tenant scope.
 *
 * - Ends without a write when the thread is gone, or when the person is not among the people of the thread's
 *   conversation any more or was never one (`listConversationPersonIds`: a person in the Trash, a person for whom one of
 *   the tenant's own mailbox addresses is indexed, a person no live message links).
 * - Takes the tasks of the thread through `Threads.tasks`, in item id order. Each task is row-locked, and its `people`
 *   value link is locked, before anything is written, and the link is read again under those locks: a task in the Trash,
 *   with no `people` link, with a link that is broken or of another rule, or whose link does not name this thread as a
 *   source is left alone. A manual change of the task's people that committed before the lock ended the link and is seen
 *   here; one that is still open holds the lock, so this waits for it and then sees the broken link.
 * - Adds the person as the `valueLinks` process, the writer of an inherited value, unless the task already has the
 *   person, and publishes one item invalidation after the commit for each task it changed.
 *
 * A second run for the same person finds the person present and writes nothing. The tenant is the job's scope; the
 * payload names none.
 */
export async function syncThreadTaskPeople(pool: Pool, payload: MailSyncThreadTaskPeoplePayload): Promise<void> {
  await withTransaction(pool, async (client) => {
    const mailThread = await client.query<Record<string, unknown>>(MAIL_THREAD_OF_ITEM_SQL, [payload.threadItemId]);
    if (!mailThread.rows[0]) return;
    // A person who is no longer in the conversation is not added. Nothing here removes a person, so a removal that
    // commits after this read is the same as one after the job.
    const conversation = await listConversationPersonIds(client, mailThreadRow.parse(mailThread.rows[0]).id);
    if (!conversation.includes(payload.personId)) return;

    const [threads, tasks] = await Promise.all([
      getDatabaseByModuleId(client, THREADS_MODULE_ID),
      getDatabaseByModuleId(client, TASKS_MODULE_ID),
    ]);
    if (!threads || !tasks) throw new Error("The Threads or Tasks database is not seeded");
    const [tasksProperty, peopleProperty] = await Promise.all([
      getPropertyByKey(client, threads.id, "tasks"),
      getPropertyByKey(client, tasks.id, "people"),
    ]);
    if (!tasksProperty || !peopleProperty) throw new Error("Threads.tasks or Tasks.people is not seeded");
    const [tasksDefinition, peopleDefinition] = await Promise.all([
      getRelationDefinitionByPropertyId(client, tasksProperty.id),
      getRelationDefinitionByPropertyId(client, peopleProperty.id),
    ]);
    if (!tasksDefinition || !peopleDefinition)
      throw new Error("Threads.tasks or Tasks.people has no relation definition");

    const taskIds = (await listRelationsForItem(client, tasksDefinition.id, payload.threadItemId))
      .map((edge) => otherSide(edge, payload.threadItemId))
      .sort();
    for (const taskId of taskIds) {
      const task = await lockItemById(client, tasks.id, taskId);
      if (!task || task.deletedAt) continue;
      const link = await lockValueLink(client, taskId, peopleProperty.key);
      if (!link || link.state !== "on" || link.ruleKey !== THREAD_TASK_PEOPLE_RULE_KEY) continue;
      const sources = await listValueLinkSourcesByLinkIds(client, [link.id]);
      if (!sources.some((source) => source.kind === "item" && source.sourceItemId === payload.threadItemId)) continue;
      const present = (await listRelationsForItem(client, peopleDefinition.id, taskId)).some(
        (edge) => otherSide(edge, taskId) === payload.personId,
      );
      if (present) continue;
      await createRelationWithClient(
        client,
        { relationPropertyId: peopleProperty.id, callerItemId: taskId, targetItemId: payload.personId },
        { ownerProcess: VALUE_LINKS_OWNER_PROCESS },
      );
      const changed = await getItemById(client, tasks.id, taskId);
      if (changed) {
        runAfterCommit(client, () =>
          notifyInvalidation({
            scope: "item",
            databaseId: changed.databaseId,
            itemId: changed.id,
            op: "update",
            updatedAt: changed.updatedAt,
          }),
        );
      }
    }
  });
}

/** What the task needs from the composition root that runs it: the pool its transaction opens on. */
export interface ThreadTaskPeopleDelivery {
  pool: Pool;
}

let delivery: ThreadTaskPeopleDelivery | null = null;

/**
 * Binds the pool the task handler uses to the process (`null` unbinds). The API queue runtime binds it before it
 * starts its runner, because a module task handler is an export of the manifest module and receives only its payload.
 */
export function setThreadTaskPeopleDelivery(next: ThreadTaskPeopleDelivery | null): void {
  delivery = next;
}

/**
 * The handler the mail manifest names for the `mailSyncThreadTaskPeople` task: `syncThreadTaskPeople` on the bound pool.
 * With none bound it throws, and the queue retries the job until a runtime that bound one runs it.
 */
export async function handleMailSyncThreadTaskPeople(payload: unknown): Promise<void> {
  const parsed = mailSyncThreadTaskPeoplePayloadSchema.parse(payload);
  if (delivery === null) throw new Error("No thread task people delivery is configured for this composition root");
  await syncThreadTaskPeople(delivery.pool, parsed);
}
