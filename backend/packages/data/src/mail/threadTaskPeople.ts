// The people of a task made from a mail thread follow the conversation by additions only, while the task's
// people are still the inherited value. The edge hook only queues a job in the edge write's transaction; the
// job does the work later under each task's row lock. Removing an edge never removes a person from a task.
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { enqueueJob } from "@alldots/queue";
import { currentTenantScope, TenantScopeMissingError } from "@alldots/shared";
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

export const MAIL_SYNC_THREAD_TASK_PEOPLE_TASK = "mailSyncThreadTaskPeople";

const MESSAGE_PEOPLE_PROPERTY_KEYS: readonly string[] = ["senderPeople", "recipientsPeople"];

const THREAD_TASK_PEOPLE_LANE = "mail-thread-task-people";

export const mailSyncThreadTaskPeoplePayloadSchema = z.strictObject({ threadItemId: z.uuid(), personId: z.uuid() });

export type MailSyncThreadTaskPeoplePayload = z.infer<typeof mailSyncThreadTaskPeoplePayloadSchema>;

const threadItemRow = z.object({ item_id: z.uuid().nullable() });
const mailThreadRow = z.object({ id: z.uuid() });

/** Both properties are seeded one-directional with the Emails side as A, so item A is the message and B the person. */
const MESSAGE_PEOPLE_RELATION_SQL = `
SELECT rd.id
FROM relation_definitions rd
JOIN properties p ON p.tenant_id = rd.tenant_id AND p.id = rd.property_id_a
JOIN databases d ON d.tenant_id = p.tenant_id AND d.id = p.database_id AND d.system AND d.owner_module_id = $2
WHERE rd.tenant_id = app_tenant_default() AND rd.id = $1 AND p.key = ANY($3::text[])`;

const MESSAGE_THREAD_ITEM_SQL = `
SELECT t.item_id
FROM mail_message_meta m
JOIN mail_threads t ON t.tenant_id = m.tenant_id AND t.id = m.thread_id
WHERE m.tenant_id = app_tenant_default() AND m.item_id = $1`;

const MAIL_THREAD_OF_ITEM_SQL = "SELECT id FROM mail_threads WHERE tenant_id = app_tenant_default() AND item_id = $1";

/**
 * The queue's job key is global, so it includes the tenant. Two people joining one thread need two jobs, and a
 * repeat for the same person collapses onto the queued one.
 */
function threadTaskPeopleJobKey(tenantId: string, payload: MailSyncThreadTaskPeoplePayload): string {
  return `${MAIL_SYNC_THREAD_TASK_PEOPLE_TASK}:${tenantId}:${payload.threadItemId}:${payload.personId}`;
}

/** Queued in the caller's transaction, so the job exists only when it commits. Throws without a tenant scope. */
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
 * Queues a job only for `op` `create` on `senderPeople`/`recipientsPeople` of a threaded message. A repeated
 * write of an existing edge also has `op` `create`; the job is idempotent.
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
 * One transaction in the job's tenant scope. Ends without a write when the thread is gone or the person is no
 * longer in the conversation.
 *
 * Each task is row-locked, then its `people` link, and the link is reread under those locks: a trashed task,
 * or a link that is missing, broken, of another rule or not sourced from this thread, is left alone. A manual
 * change of the task's people ends the link; one still open holds the lock, so this waits and then sees the
 * broken link. The person is added as the `valueLinks` process unless already present.
 */
export async function syncThreadTaskPeople(pool: Pool, payload: MailSyncThreadTaskPeoplePayload): Promise<void> {
  await withTransaction(pool, async (client) => {
    const mailThread = await client.query<Record<string, unknown>>(MAIL_THREAD_OF_ITEM_SQL, [payload.threadItemId]);
    if (!mailThread.rows[0]) return;
    // Nothing here removes a person, so a removal committing after this read is the same as one after the job.
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

export interface ThreadTaskPeopleDelivery {
  pool: Pool;
}

let delivery: ThreadTaskPeopleDelivery | null = null;

/** A module task handler receives only its payload, so the queue runtime binds this before starting its runner. */
export function setThreadTaskPeopleDelivery(next: ThreadTaskPeopleDelivery | null): void {
  delivery = next;
}

/** With none bound it throws, and the queue retries until a runtime that bound one runs it. */
export async function handleMailSyncThreadTaskPeople(payload: unknown): Promise<void> {
  const parsed = mailSyncThreadTaskPeoplePayloadSchema.parse(payload);
  if (delivery === null) throw new Error("No thread task people delivery is configured for this composition root");
  await syncThreadTaskPeople(delivery.pool, parsed);
}
