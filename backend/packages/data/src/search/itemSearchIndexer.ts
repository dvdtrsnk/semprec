import type { PoolClient } from "pg";
import { z } from "zod";
import type { ItemCreateHook, ItemUpdateHook } from "../chokePoint/hooks.js";
import { visibleDatabaseIds } from "../chokePoint/itemsStore.js";
import { listPropertiesByDatabase } from "../chokePoint/propertiesStore.js";
import { requireAffectedRows } from "../db/pool.js";
import { createCatalogResolver, toManifestLocale } from "../manifest/catalogResolution.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import { EMAILS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { AREAS_MODULE_ID, COMPANIES_MODULE_ID, PEOPLE_MODULE_ID, PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { buildItemSearchBody, buildItemSearchDocument } from "./itemSearchDocument.js";

const SEARCH_VECTOR_SQL = "to_tsvector('czech', $3) || to_tsvector('czech_simple', $3)";
const jsonObject = z.record(z.string(), z.unknown());

interface SearchItemDbRow {
  id: string;
  database_id: string;
  owner_module_id: string | null;
  properties: unknown;
  computed: unknown;
}

interface RelatedTitleDbRow {
  id: string;
  owner_module_id: string | null;
  title: unknown;
}

/** Batches both directions using the property on the source item's side of the definition. */
async function relatedTitles(
  client: PoolClient,
  sourceIds: string[],
  databaseIds: string[],
  declaredFields: string[],
  includedModuleIds: string[],
): Promise<RelatedTitleDbRow[]> {
  if (sourceIds.length === 0) return [];
  const { rows } = await client.query<RelatedTitleDbRow>(
    `SELECT target.id, target_db.owner_module_id, target.properties -> title_property.key AS title
     FROM items source
     JOIN item_relations edge ON edge.item_a = source.id OR edge.item_b = source.id
     JOIN relation_definitions definition ON definition.id = edge.relation_definition_id
     JOIN properties source_property
       ON source_property.id = CASE WHEN edge.item_a = source.id THEN definition.property_id_a ELSE definition.property_id_b END
       AND source_property.database_id = source.database_id AND source_property.type = 'relation'
     JOIN items target ON target.id = CASE WHEN edge.item_a = source.id THEN edge.item_b ELSE edge.item_a END
       AND target.database_id = ANY($2::uuid[]) AND target.deleted_at IS NULL
     JOIN databases target_db ON target_db.id = target.database_id
     JOIN properties title_property ON title_property.database_id = target.database_id AND title_property.type = 'title'
     WHERE source.id = ANY($1::uuid[]) AND source.database_id = ANY($2::uuid[]) AND source.deleted_at IS NULL
       AND (source_property.key = ANY($3::text[]) OR target_db.owner_module_id = ANY($4::text[]))
     ORDER BY source.id, source_property.key, target.id, title_property.key`,
    [sourceIds, databaseIds, declaredFields, includedModuleIds],
  );
  return rows;
}

/**
 * Read in its own statement after the item lock, not joined into the locking query: a join read taken before the
 * lock could miss a page-text write that committed while this call was waiting for the lock.
 */
async function storedProjection(
  client: PoolClient,
  itemId: string,
): Promise<{ body: string | null; pageText: string | null }> {
  const { rows } = await client.query<{ body: string | null; page_text: string | null }>(
    `SELECT body, page_text FROM item_search_index WHERE item_id = $1`,
    [itemId],
  );
  return { body: rows[0]?.body ?? null, pageText: rows[0]?.page_text ?? null };
}

/**
 * Called inside a write transaction. Locks the item before reading its text, including during backfills.
 * `pageText` is passed only by the page-text job, the sole writer of `page_text`; without it the stored page text
 * is kept, so an item write rebuilds the vector and `body` from the text already converted.
 */
export async function indexItem(
  client: PoolClient,
  itemId: string,
  options: { onlyMissing?: boolean; pageText?: string; preserveBody?: boolean } = {},
): Promise<void> {
  const databaseIds = await visibleDatabaseIds(client);
  const { rows } = await client.query<SearchItemDbRow>(
    `SELECT i.id, i.database_id, d.owner_module_id, i.properties, i.computed
     FROM items i JOIN databases d ON d.id = i.database_id
     WHERE i.id = $1 AND i.database_id = ANY($2::uuid[]) AND i.deleted_at IS NULL
       AND d.owner_module_id IS DISTINCT FROM $3
     FOR UPDATE OF i`,
    [itemId, databaseIds, EMAILS_MODULE_ID],
  );
  const item = rows[0];
  if (!item) return;

  const registry = await loadFullModuleRegistry();
  const descriptor = (await registry.getDatabases()).find((db) => db.key === item.owner_module_id);
  const properties = await listPropertiesByDatabase(client, item.database_id);
  const { rows: users } = await client.query<{ locale: string }>(
    `SELECT locale FROM users WHERE tenant_id = (SELECT app_tenant_default()) ORDER BY created_at, id LIMIT 1`,
  );
  const locale = toManifestLocale(users[0]?.locale ?? "cs");
  const catalogs = await (await createCatalogResolver(registry)).getCatalogsForDbKey(item.owner_module_id);
  const linked = await relatedTitles(client, [itemId], databaseIds, descriptor?.searchFields ?? [], [
    PROJECTS_MODULE_ID,
    AREAS_MODULE_ID,
    PEOPLE_MODULE_ID,
    COMPANIES_MODULE_ID,
  ]);
  const projectAreas = await relatedTitles(
    client,
    [...new Set(linked.filter((row) => row.owner_module_id === PROJECTS_MODULE_ID).map((row) => row.id))],
    databaseIds,
    ["area"],
    [],
  );
  const stored =
    options.pageText === undefined || options.preserveBody
      ? await storedProjection(client, item.id)
      : { body: null, pageText: null };
  const pageText = options.pageText ?? stored.pageText;
  const itemInput = { properties: jsonObject.parse(item.properties), computed: jsonObject.parse(item.computed) };
  const document = buildItemSearchDocument({
    item: itemInput,
    databaseKey: item.owner_module_id,
    descriptor,
    properties,
    relatedTitles: [...linked, ...projectAreas].flatMap((row) => (typeof row.title === "string" ? [row.title] : [])),
    pageText,
    locale,
    catalogs,
  });
  const searchDocument = options.preserveBody && stored.body ? `${document} ${stored.body}` : document;
  const body = buildItemSearchBody({ item: itemInput, databaseKey: item.owner_module_id, pageText });
  // SEARCH_VECTOR_SQL is a closed SQL constant; all values, including the missing-only guard, are bound.
  // An item write leaves the stored `page_text` column as it is; only the page-text job (`$7`) replaces it.
  const result = await client.query(
    `INSERT INTO item_search_index (item_id, database_id, search_vector, body, page_text, updated_at)
     VALUES ($1, $2, ${SEARCH_VECTOR_SQL}, $4, $5, now())
     ON CONFLICT (item_id) DO UPDATE SET search_vector = EXCLUDED.search_vector,
       database_id = EXCLUDED.database_id,
       body = CASE WHEN $8::boolean THEN item_search_index.body ELSE EXCLUDED.body END,
       page_text = CASE WHEN $7::boolean THEN EXCLUDED.page_text ELSE item_search_index.page_text END,
       updated_at = now()
     WHERE NOT $6::boolean`,
    [
      item.id,
      item.database_id,
      searchDocument,
      body,
      pageText ?? null,
      options.onlyMissing ?? false,
      options.pageText !== undefined,
      options.preserveBody ?? false,
    ],
  );
  if (!options.onlyMissing) requireAffectedRows(result, "item search index upsert");
}

export const itemSearchCreateHook: ItemCreateHook = async ({ client, item }) => {
  await indexItem(client, item.id);
};

export const itemSearchUpdateHook: ItemUpdateHook = async ({ client, item }) => {
  await indexItem(client, item.id);
};
