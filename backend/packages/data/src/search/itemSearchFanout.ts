// Issue #1652: keeps the search documents of items that quote another item's text current. An item's
// document contains the titles of the projects, areas, people and companies it links to, the area of
// its project and, for a Journal day, its Inbox entries' text; a change to any of them is fanned out
// as queued reindex jobs. Dependents are looked up when the job runs, in committed chunks
// (docs/adr/2026-09-28-chunked-transactions-for-large-background-sweeps.md), so a write never expands
// a referrer set inside its own transaction. Emails are never reindexed here: mail owns their rows.
// A Journal day quotes its Inbox entries through its cached `computed.inboxItems`, which only the
// Inbox owner's recompute rewrites, so Inbox writes also queue that recompute (see `journalDaysOf`).
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { currentTenantScope } from "@semprec/shared";
import type {
  ItemCreateHook,
  ItemDeleteHook,
  ItemRestoreHook,
  ItemUpdateHook,
  RelationEdgeChangedHook,
} from "../chokePoint/hooks.js";
import { getPropertyByKey, listPropertiesByDatabase } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { withTransaction } from "../db/pool.js";
import { enqueueJournalInboxRecompute } from "../inbox/journalInboxCompute.js";
import { EMAILS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { INBOX_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { AREAS_MODULE_ID, PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { tenantLane } from "../tenancy/tenantLane.js";
import { enqueueItemSearchBackfill } from "./itemSearchBackfill.js";
import { indexItem } from "./itemSearchIndexer.js";

const CHUNK_SIZE = 100;

const reindexPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("item"), itemId: z.uuid() }).strict(),
  z.object({ kind: z.literal("referrers"), itemId: z.uuid(), afterItemId: z.uuid().optional() }).strict(),
  z.object({ kind: z.literal("projectItems"), projectItemId: z.uuid(), afterItemId: z.uuid().optional() }).strict(),
]);
export type ItemSearchReindexPayload = z.infer<typeof reindexPayloadSchema>;

/**
 * Queues one `itemSearchReindexDependents` job in the caller's transaction, on the tenant's
 * `item-search-index` lane. The key names the item or the scope, so repeated changes before the job
 * runs collapse into one (`jobKeyMode: "replace"`); a continuation's cursor is part of its key, so a
 * running chunk never absorbs it. Outside a tenant scope (only the transitional `warn` mode lets a
 * write run there) a tenant task could not run, so nothing is queued.
 */
export async function enqueueItemSearchReindex(client: PoolClient, payload: ItemSearchReindexPayload): Promise<void> {
  const parsed = reindexPayloadSchema.parse(payload);
  if (currentTenantScope()?.kind !== "tenant") return;
  const scopeKey =
    parsed.kind === "item"
      ? parsed.itemId
      : `${parsed.kind === "referrers" ? parsed.itemId : parsed.projectItemId}:${parsed.afterItemId ?? "start"}`;
  await enqueueJob(client, CORE_TASK_NAMES.ITEM_SEARCH_REINDEX_DEPENDENTS, parsed, {
    jobKey: `item-search-reindex:${parsed.kind}:${scopeKey}`,
    jobKeyMode: "replace",
    queueName: tenantLane("item-search-index"),
    maxAttempts: 3,
  });
}

/**
 * Queues the tenant-wide rebuild of every search document (`itemSearchBackfill` with
 * `onlyMissing: false`), for a change that alters every document of the tenant (the profile language
 * change of issue #1704). Must run in a tenant scope.
 */
export async function enqueueTenantSearchReindex(client: PoolClient): Promise<void> {
  await enqueueItemSearchBackfill(client, { onlyMissing: false });
}

interface DependentRow {
  id: string;
  owner_module_id: string | null;
}

/**
 * The next chunk of live, non-Email items with a relation edge to `itemId` (in either direction), in
 * id order after `afterItemId`; `moduleIds` narrows them to those system databases.
 */
async function dependentChunk(
  client: PoolClient,
  itemId: string,
  afterItemId: string | undefined,
  moduleIds: readonly string[] | null,
): Promise<DependentRow[]> {
  const { rows } = await client.query<DependentRow>(
    `SELECT DISTINCT other.id, d.owner_module_id
     FROM item_relations r
     JOIN items other ON other.tenant_id = r.tenant_id
       AND other.id = CASE WHEN r.item_a = $1 THEN r.item_b ELSE r.item_a END AND other.deleted_at IS NULL
     JOIN databases d ON d.tenant_id = other.tenant_id AND d.id = other.database_id
     WHERE r.tenant_id = app_tenant_default() AND (r.item_a = $1 OR r.item_b = $1) AND other.id <> $1
       AND d.owner_module_id IS DISTINCT FROM $2
       AND ($3::text[] IS NULL OR (d.system AND d.owner_module_id = ANY($3::text[])))
       AND ($4::uuid IS NULL OR other.id > $4)
     ORDER BY other.id LIMIT $5`,
    [itemId, EMAILS_MODULE_ID, moduleIds, afterItemId ?? null, CHUNK_SIZE],
  );
  return rows;
}

/** The system module that owns `itemId`'s database, read whether or not the item is in the Trash. */
async function ownerModuleOf(client: PoolClient, itemId: string): Promise<string | null> {
  const { rows } = await client.query<{ owner_module_id: string | null }>(
    `SELECT d.owner_module_id FROM items i JOIN databases d ON d.tenant_id = i.tenant_id AND d.id = i.database_id
     WHERE i.tenant_id = app_tenant_default() AND i.id = $1 AND d.system`,
    [itemId],
  );
  return rows[0]?.owner_module_id ?? null;
}

/** The databases whose items show a project's title and its area's: the items related to a project. */
const PROJECT_ITEM_MODULE_IDS = ["tasks", "events", "files", "healthRecords"] as const;

/**
 * `itemSearchReindexDependents`: `item` rebuilds one document; `referrers` rebuilds every live item
 * with an edge to `itemId`, and when that item is an Area also queues `projectItems` for each of its
 * live Project referrers, whose items quote the area through their project; `projectItems` rebuilds
 * the project's tasks, events, files and health records. Each invocation commits at most one chunk
 * of `CHUNK_SIZE` together with the job for the next one; an error rolls that chunk back.
 */
export async function handleItemSearchReindexDependentsTask(pool: Pool, rawPayload: unknown): Promise<void> {
  const payload = reindexPayloadSchema.parse(rawPayload);
  await withTransaction(pool, async (client) => {
    if (payload.kind === "item") {
      await indexItem(client, payload.itemId);
      return;
    }
    const sourceId = payload.kind === "referrers" ? payload.itemId : payload.projectItemId;
    const chunk = await dependentChunk(
      client,
      sourceId,
      payload.afterItemId,
      payload.kind === "projectItems" ? PROJECT_ITEM_MODULE_IDS : null,
    );
    for (const row of chunk) await indexItem(client, row.id);
    if (
      payload.kind === "referrers" &&
      chunk.length > 0 &&
      (await ownerModuleOf(client, sourceId)) === AREAS_MODULE_ID
    ) {
      for (const row of chunk) {
        if (row.owner_module_id === PROJECTS_MODULE_ID)
          await enqueueItemSearchReindex(client, { kind: "projectItems", projectItemId: row.id });
      }
    }
    const last = chunk.at(-1);
    if (chunk.length === CHUNK_SIZE && last) {
      await enqueueItemSearchReindex(
        client,
        payload.kind === "referrers"
          ? { kind: "referrers", itemId: sourceId, afterItemId: last.id }
          : { kind: "projectItems", projectItemId: sourceId, afterItemId: last.id },
      );
    }
  });
}

/**
 * After an edge is written or deleted (issue #1530's hook): both ends' documents; when the edge is a
 * project's `area` edge, also the project's items, which show the area through their project.
 */
export const itemSearchEdgeChangedHook: RelationEdgeChangedHook = async (context) => {
  await enqueueItemSearchReindex(context.client, { kind: "item", itemId: context.itemA });
  await enqueueItemSearchReindex(context.client, { kind: "item", itemId: context.itemB });
  const { rows } = await context.client.query<{ owner_module_id: string | null; key: string; is_a: boolean }>(
    `SELECT d.owner_module_id, p.key, rd.property_id_a = p.id AS is_a
     FROM relation_definitions rd
     JOIN properties p ON p.tenant_id = rd.tenant_id AND p.id IN (rd.property_id_a, rd.property_id_b)
     JOIN databases d ON d.tenant_id = p.tenant_id AND d.id = p.database_id
     WHERE rd.tenant_id = app_tenant_default() AND rd.id = $1 AND d.system`,
    [context.relationDefinitionId],
  );
  const areaSide = rows.find((row) => row.owner_module_id === PROJECTS_MODULE_ID && row.key === "area");
  if (areaSide)
    await enqueueItemSearchReindex(context.client, {
      kind: "projectItems",
      projectItemId: areaSide.is_a ? context.itemA : context.itemB,
    });
};

/**
 * An update whose patch writes the database's title property: the items that link to it. For an
 * Area, the queued `referrers` job also reaches its projects' items. A patch that writes the same
 * title again queues the same deduplicated job.
 */
export const itemSearchTitleUpdateHook: ItemUpdateHook = async ({ client, database, item, propertiesPatch }) => {
  const title = (await listPropertiesByDatabase(client, database.id)).find((property) => property.type === "title");
  if (!title || !Object.hasOwn(propertiesPatch, title.key)) return;
  await enqueueItemSearchReindex(client, { kind: "referrers", itemId: item.id });
};

/**
 * The Journal days an Inbox entry's `journalDay` edges point at; none for an item of any other
 * database. A day's document quotes its entries through the day's cached `computed.inboxItems`
 * (issue #106), which only the Inbox owner's recompute rewrites: it rewrites the cache and reindexes
 * the day in one transaction under the day's row lock, the lock `indexItem` also takes. So whichever
 * of that recompute and a search job of the day runs last indexes the committed cache.
 */
async function journalDaysOf(
  client: PoolClient,
  database: { id: string; ownerModuleId: string | null; system: boolean },
  itemId: string,
): Promise<string[]> {
  if (!database.system || database.ownerModuleId !== INBOX_MODULE_ID) return [];
  const property = await getPropertyByKey(client, database.id, "journalDay");
  const definition = property && (await getRelationDefinitionByPropertyId(client, property.id));
  if (!definition) return [];
  return (await listRelationsForItem(client, definition.id, itemId)).map((edge) => otherSide(edge, itemId));
}

/**
 * A soft-deleted row (issue #1601's hook): the items that link to it stop quoting its text. For an
 * Inbox entry, its Journal days' cached entry lists are recomputed too, which leaves the trashed
 * entry out.
 */
export const itemSearchDeleteHook: ItemDeleteHook = async ({ client, database, item }) => {
  await enqueueItemSearchReindex(client, { kind: "referrers", itemId: item.id });
  for (const day of await journalDaysOf(client, database, item.id)) await enqueueJournalInboxRecompute(client, day);
};

/** A restored row: the items that link to it quote its text again; an Inbox entry's days are recomputed. */
export const itemSearchRestoreHook: ItemRestoreHook = async ({ client, database, item }) => {
  await enqueueItemSearchReindex(client, { kind: "referrers", itemId: item.id });
  for (const day of await journalDaysOf(client, database, item.id)) await enqueueJournalInboxRecompute(client, day);
};

/**
 * An Inbox entry created: the document of each Journal day its `journalDay` edges point at when this
 * hook runs. Registered before the Inbox owner's create hook (domainWriteHooks.ts), it finds no edge
 * for an ordinary capture: that owner hook then writes the `journalDay` edge, whose edge-changed hook
 * queues the day's document, and queues the day's recompute itself.
 */
export const itemSearchInboxCreateHook: ItemCreateHook = async ({ client, database, item }) => {
  for (const day of await journalDaysOf(client, database, item.id))
    await enqueueItemSearchReindex(client, { kind: "item", itemId: day });
};

/** An Inbox entry changed: the Journal day's document, and the owner's recompute of the day's cached entries. */
export const itemSearchInboxUpdateHook: ItemUpdateHook = async ({ client, database, item }) => {
  for (const day of await journalDaysOf(client, database, item.id)) {
    await enqueueItemSearchReindex(client, { kind: "item", itemId: day });
    await enqueueJournalInboxRecompute(client, day);
  }
};
