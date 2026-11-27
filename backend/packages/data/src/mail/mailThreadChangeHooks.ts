import type { PoolClient } from "pg";
import { z } from "zod";
import type { ItemDeleteHook, ItemRestoreHook, ItemUpdateHook, RelationEdgeChangedHook } from "../chokePoint/hooks.js";
import type { DatabaseRow } from "../types.js";
import { EMAILS_MODULE_ID, FOLDERS_MODULE_ID, MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";
import { COMPANIES_MODULE_ID, PEOPLE_MODULE_ID, PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { touchAllMailThreads, touchMailThreads } from "./mailThreadChanges.js";

/**
 * The properties a thread list row reads, per owning module of the written item. A mailbox's or a folder's reach
 * every row at once (the mailbox names, the user's own addresses, which folder is an Inbox).
 */
const LIST_KEYS: Readonly<Record<string, readonly string[]>> = {
  [EMAILS_MODULE_ID]: ["read", "flagged", "name", "date"],
  [MAILBOXES_MODULE_ID]: ["name", "provider", "addresses"],
  [FOLDERS_MODULE_ID]: ["specialPurpose"],
  [PROJECTS_MODULE_ID]: ["name"],
  [COMPANIES_MODULE_ID]: ["name"],
  [PEOPLE_MODULE_ID]: ["name", "relationship"],
};

const threadIdRows = z.array(z.object({ thread_id: z.uuid() }));

async function threadIdsOf(client: PoolClient, sql: string, params: unknown[]): Promise<string[]> {
  const { rows } = await client.query<{ thread_id: unknown }>(sql, params);
  return threadIdRows.parse(rows).map((row) => row.thread_id);
}

const OWN_THREAD_SQL = `SELECT thread_id FROM mail_message_meta
  WHERE tenant_id = app_tenant_default() AND item_id = $1 AND thread_id IS NOT NULL`;

/** Threads whose Threads item has any edge to the item: its project or company. */
const LINKED_THREADS_SQL = `SELECT t.id AS thread_id FROM item_relations r
  JOIN mail_threads t ON t.tenant_id = r.tenant_id AND t.item_id = CASE WHEN r.item_a = $1 THEN r.item_b ELSE r.item_a END
  WHERE r.tenant_id = app_tenant_default() AND (r.item_a = $1 OR r.item_b = $1)`;

/** Threads with a message from one of the person's indexed addresses (the list's sender person). */
const PERSON_THREADS_SQL = `SELECT DISTINCT m.thread_id FROM person_email_index pei
  JOIN mail_message_meta m ON m.tenant_id = pei.tenant_id
    AND lower(btrim(m.envelope->'from'->>'address', E' \\t\\n\\r')) = pei.email
  WHERE pei.tenant_id = app_tenant_default() AND pei.item_id = $1 AND m.thread_id IS NOT NULL`;

/** Records the list rows a change of the item reaches. */
async function touchForItem(client: PoolClient, database: DatabaseRow, itemId: string): Promise<void> {
  switch (database.ownerModuleId) {
    case EMAILS_MODULE_ID:
      touchMailThreads(client, await threadIdsOf(client, OWN_THREAD_SQL, [itemId]));
      return;
    case MAILBOXES_MODULE_ID:
    case FOLDERS_MODULE_ID:
      touchAllMailThreads(client);
      return;
    case PROJECTS_MODULE_ID:
    case COMPANIES_MODULE_ID:
      touchMailThreads(client, await threadIdsOf(client, LINKED_THREADS_SQL, [itemId]));
      return;
    case PEOPLE_MODULE_ID:
      touchMailThreads(client, await threadIdsOf(client, PERSON_THREADS_SQL, [itemId]));
      return;
    default:
      return;
  }
}

/** A patch that leaves every list property as it was changes no row. */
export const mailThreadChangeItemUpdateHook: ItemUpdateHook = async ({
  client,
  database,
  item,
  propertiesPatch,
  previous,
}) => {
  const keys = database.ownerModuleId === null ? undefined : LIST_KEYS[database.ownerModuleId];
  if (keys === undefined) return;
  const changed = keys.some(
    (key) =>
      Object.hasOwn(propertiesPatch, key) &&
      (previous === undefined ||
        JSON.stringify(previous[key] ?? null) !== JSON.stringify(propertiesPatch[key] ?? null)),
  );
  if (changed) await touchForItem(client, database, item.id);
};

export const mailThreadChangeItemDeleteHook: ItemDeleteHook = async ({ client, database, item }) => {
  await touchForItem(client, database, item.id);
};

export const mailThreadChangeItemRestoreHook: ItemRestoreHook = async ({ client, database, item }) => {
  await touchForItem(client, database, item.id);
};

/**
 * The threads whose list rows an edge change reaches, by the property on each side (`$1` the definition, `$2` and `$3`
 * its items): an Emails item's folder or people, a Threads item's project or company, a project's area (the list's
 * area filter). With `$4` the edge's metadata changed and nothing else (an update, or a create of an edge that
 * existed); that only reaches a row through a Sent folder edge, whose UID decides whether the copy is received.
 */
const EDGE_THREADS_SQL = `WITH sides AS (
  SELECT side.item_id, side.other_id, p.key, d.owner_module_id AS module
  FROM relation_definitions rd
  CROSS JOIN LATERAL (VALUES (rd.property_id_a, $2::uuid, $3::uuid), (rd.property_id_b, $3::uuid, $2::uuid))
    side(property_id, item_id, other_id)
  JOIN properties p ON p.tenant_id = rd.tenant_id AND p.id = side.property_id
  JOIN databases d ON d.tenant_id = p.tenant_id AND d.id = p.database_id AND d.system
  WHERE rd.tenant_id = app_tenant_default() AND rd.id = $1
)
SELECT m.thread_id FROM sides s
JOIN mail_message_meta m ON m.tenant_id = app_tenant_default() AND m.item_id = s.item_id AND m.thread_id IS NOT NULL
WHERE s.module = 'emails' AND (
  (s.key IN ('senderPeople', 'recipientsPeople') AND NOT $4::boolean)
  OR (s.key = 'folder' AND (NOT $4::boolean OR EXISTS (
    SELECT 1 FROM items f WHERE f.tenant_id = app_tenant_default() AND f.id = s.other_id
      AND f.properties->>'specialPurpose' = 'sent'))))
UNION
SELECT t.id FROM sides s JOIN mail_threads t ON t.tenant_id = app_tenant_default() AND t.item_id = s.item_id
WHERE s.module = 'threads' AND s.key IN ('project', 'company') AND NOT $4::boolean
UNION
SELECT t.id FROM sides s
JOIN item_relations r ON r.tenant_id = app_tenant_default() AND (r.item_a = s.item_id OR r.item_b = s.item_id)
JOIN mail_threads t ON t.tenant_id = app_tenant_default()
  AND t.item_id = CASE WHEN r.item_a = s.item_id THEN r.item_b ELSE r.item_a END
WHERE s.module = 'projects' AND s.key = 'area' AND NOT $4::boolean`;

export const mailThreadChangeEdgeChangedHook: RelationEdgeChangedHook = async (context) => {
  const metadataOnly = context.op === "update" || context.repeated === true;
  const threadIds = await threadIdsOf(context.client, EDGE_THREADS_SQL, [
    context.relationDefinitionId,
    context.itemA,
    context.itemB,
    metadataOnly,
  ]);
  if (threadIds.length > 0) touchMailThreads(context.client, threadIds);
};
