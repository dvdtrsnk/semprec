// Keeps search documents that quote another item's text current (linked project, area, person and company
// titles, a project's area, a Journal day's Inbox entries) by queuing reindex jobs. Dependents are looked up when
// the job runs, in committed chunks, so a write never expands a referrer set inside its own transaction. Emails are
// never reindexed here: mail owns their rows.
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES } from "@semprec/queue";
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
import { isLiveJournalDay, recomputeJournalInboxDayWithClient } from "../inbox/journalInboxCompute.js";
import { EMAILS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { INBOX_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { AREAS_MODULE_ID, PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { enqueueItemSearchBackfill } from "./itemSearchBackfill.js";
import { indexItem } from "./itemSearchIndexer.js";
import { enqueueSearchLaneJob } from "./searchLaneEnqueue.js";

const CHUNK_SIZE = 100;

const reindexPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("item"), itemId: z.uuid() }).strict(),
  z.object({ kind: z.literal("referrers"), itemId: z.uuid(), afterItemId: z.uuid().optional() }).strict(),
  z.object({ kind: z.literal("projectItems"), projectItemId: z.uuid(), afterItemId: z.uuid().optional() }).strict(),
]);
export type ItemSearchReindexPayload = z.infer<typeof reindexPayloadSchema>;

/**
 * Queued on the tenant's `item-search-index` lane at the pre-commit flush. The key names the item or scope, so
 * repeated changes collapse (`jobKeyMode: "replace"`); a continuation's cursor is part of its key, so a running
 * chunk never absorbs it. Outside a tenant scope nothing is queued, since a tenant task could not run.
 */
export async function enqueueItemSearchReindex(client: PoolClient, payload: ItemSearchReindexPayload): Promise<void> {
  const parsed = reindexPayloadSchema.parse(payload);
  if (currentTenantScope()?.kind !== "tenant") return;
  const scopeKey =
    parsed.kind === "item"
      ? parsed.itemId
      : `${parsed.kind === "referrers" ? parsed.itemId : parsed.projectItemId}:${parsed.afterItemId ?? "start"}`;
  enqueueSearchLaneJob(client, CORE_TASK_NAMES.ITEM_SEARCH_REINDEX_DEPENDENTS, parsed, {
    jobKey: `item-search-reindex:${parsed.kind}:${scopeKey}`,
    jobKeyMode: "replace",
    maxAttempts: 3,
  });
}

/** Rebuilds every search document of the tenant (e.g. a profile language change). Must run in a tenant scope. */
export async function enqueueTenantSearchReindex(client: PoolClient): Promise<void> {
  await enqueueItemSearchBackfill(client, {});
}

interface DependentRow {
  id: string;
  owner_module_id: string | null;
}

/** Live non-Email items with an edge to `itemId` in either direction, in id order after `afterItemId`. */
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

/** Read whether or not the item is in the Trash. */
async function ownerModuleOf(client: PoolClient, itemId: string): Promise<string | null> {
  const { rows } = await client.query<{ owner_module_id: string | null }>(
    `SELECT d.owner_module_id FROM items i JOIN databases d ON d.tenant_id = i.tenant_id AND d.id = i.database_id
     WHERE i.tenant_id = app_tenant_default() AND i.id = $1 AND d.system`,
    [itemId],
  );
  return rows[0]?.owner_module_id ?? null;
}

/** The items related to a project, which show its title and its area's. */
const PROJECT_ITEM_MODULE_IDS = ["tasks", "events", "files", "healthRecords"] as const;

/**
 * `item` rebuilds one document; `referrers` every live item with an edge to `itemId` (for an Area also queuing
 * `projectItems` per live Project referrer); `projectItems` the project's items. Each invocation commits at most
 * one `CHUNK_SIZE` chunk together with the next chunk's job.
 */
export async function handleItemSearchReindexDependentsTask(pool: Pool, rawPayload: unknown): Promise<void> {
  const payload = reindexPayloadSchema.parse(rawPayload);
  await withTransaction(pool, async (client) => {
    if (payload.kind === "item") {
      // A Journal day quotes its cached Inbox entries, which only the Inbox owner rewrites: the owner's recompute
      // rewrites the cache and indexes the day under the day's row lock.
      if (await isLiveJournalDay(client, payload.itemId))
        await recomputeJournalInboxDayWithClient(client, payload.itemId);
      else await indexItem(client, payload.itemId);
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

/** Both ends' documents; for a project's `area` edge also the project's items. */
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

/** A title write reindexes the items linking to it (an Area's `referrers` job also reaches its projects' items). */
export const itemSearchTitleUpdateHook: ItemUpdateHook = async ({ client, database, item, propertiesPatch }) => {
  const title = (await listPropertiesByDatabase(client, database.id)).find((property) => property.type === "title");
  if (!title || !Object.hasOwn(propertiesPatch, title.key)) return;
  await enqueueItemSearchReindex(client, { kind: "referrers", itemId: item.id });
};

/**
 * The Journal days an Inbox entry's `journalDay` edges point at. Their `item` job runs the Inbox owner's
 * recompute, which rewrites the cached entries and reindexes the day under the row lock `indexItem` also takes.
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

/** Referrers stop quoting the trashed item; an Inbox entry's day recomputes and leaves it out. */
export const itemSearchDeleteHook: ItemDeleteHook = async ({ client, database, item }) => {
  await enqueueItemSearchReindex(client, { kind: "referrers", itemId: item.id });
  for (const day of await journalDaysOf(client, database, item.id))
    await enqueueItemSearchReindex(client, { kind: "item", itemId: day });
};

export const itemSearchRestoreHook: ItemRestoreHook = async ({ client, database, item }) => {
  await enqueueItemSearchReindex(client, { kind: "referrers", itemId: item.id });
  for (const day of await journalDaysOf(client, database, item.id))
    await enqueueItemSearchReindex(client, { kind: "item", itemId: day });
};

/**
 * Registered before the Inbox owner's create hook, so an ordinary capture finds no edge here: the owner then writes
 * the `journalDay` edge, whose edge hook queues the day's document.
 */
export const itemSearchInboxCreateHook: ItemCreateHook = async ({ client, database, item }) => {
  for (const day of await journalDaysOf(client, database, item.id))
    await enqueueItemSearchReindex(client, { kind: "item", itemId: day });
};

export const itemSearchInboxUpdateHook: ItemUpdateHook = async ({ client, database, item }) => {
  for (const day of await journalDaysOf(client, database, item.id))
    await enqueueItemSearchReindex(client, { kind: "item", itemId: day });
};
