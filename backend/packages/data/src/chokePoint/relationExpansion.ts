import type { PoolClient } from "pg";
import { z } from "zod";
import type {
  ExpandedRelationTarget,
  HiddenRelationTarget,
  ItemRelationTarget,
  ReducedRelationTarget,
} from "@semprec/shared";
import type { CollectionMetadataResolver } from "../manifest/collectionMetadata.js";
import type { ItemRow, PropertyRow } from "../types.js";
import { ValidationError } from "../errors.js";
import { listPropertiesByDatabases } from "./propertiesStore.js";
import { projectItemForRead } from "./hooks.js";
import { listUnreadableDatabaseIds, type DatabaseReader } from "../agentGrants/agentDatabaseAccess.js";
import { itemIdsLinkedToDatabases } from "../agentGrants/inheritedSensitivity.js";

export interface RelationExpansionOptions {
  relations: Record<string, string[]> | true;
  resolver: CollectionMetadataResolver;
  databaseIds?: string[];
  /**
   * The databases whose items the reader may not read (an agent's project, issue #1810). A target in one is
   * returned as `{ id, hidden: true }` only, at the top level and inside a projected relation property.
   */
  unreadableDatabaseIds?: ReadonlySet<string>;
  /**
   * Also hides a target of a database that inherits sensitivity (Files, Transcripts, Inbox) that is linked to a
   * database in `unreadableDatabaseIds` (issue #1999). Set for an agent's project only.
   */
  hideInheritedSensitiveTargets?: boolean;
}
/**
 * The expansion a restricted reader's read runs under: the relation targets in the databases an agent's project
 * (issue #1810) or an external client (issue #1998) may not read are hidden, and for an agent's project the targets
 * that inherit sensitivity from such a database (issue #1999). A person gets `expansion` untouched.
 */
export async function expansionForReader(
  client: PoolClient,
  expansion: RelationExpansionOptions | undefined,
  reader: DatabaseReader | undefined,
): Promise<RelationExpansionOptions | undefined> {
  if (!expansion || reader === undefined) return expansion;
  return {
    ...expansion,
    unreadableDatabaseIds: await listUnreadableDatabaseIds(client, reader),
    ...(typeof reader === "string" ? { hideInheritedSensitiveTargets: true } : {}),
  };
}

/** The ids among `itemIds` that `options` hides because they inherit sensitivity (issue #1999), in one query. */
async function hiddenInheritedTargetIds(
  client: PoolClient,
  itemIds: readonly string[],
  options: RelationExpansionOptions,
): Promise<Set<string>> {
  if (!options.hideInheritedSensitiveTargets || options.unreadableDatabaseIds === undefined) return new Set();
  return itemIdsLinkedToDatabases(client, itemIds, options.unreadableDatabaseIds);
}

type ExpandedItem = ItemRow & { relations?: Record<string, ItemRelationTarget[]>; relationsTruncated?: string[] };
type Edge = {
  id: string;
  property_id: string;
  source_id: string;
  target_id: string;
  metadata: unknown;
};
const jsonObject = z.record(z.string(), z.unknown());

function invalid(field: string): never {
  throw new ValidationError("Invalid relation projection", { field });
}
function targetDatabase(property: PropertyRow): string {
  const id = property.config.targetDatabaseId;
  if (typeof id !== "string") throw new Error("Relation property has no target database");
  return id;
}
/** Batched expansion in the surrounding tenant transaction; no write or manifest loading. */
export async function expandItemRelations(
  client: PoolClient,
  items: ItemRow[],
  options: RelationExpansionOptions,
): Promise<ExpandedItem[]> {
  const sourceIds = options.databaseIds ?? [...new Set(items.map((item) => item.databaseId))];
  const sourceSchemas = await listPropertiesByDatabases(client, sourceIds);
  for (const id of sourceIds) if (!sourceSchemas.has(id)) sourceSchemas.set(id, []);
  if (options.relations !== true && Object.keys(options.relations).length > 5) invalid("include.relations");
  if (sourceIds.length === 0 && options.relations !== true && Object.keys(options.relations).length > 0)
    invalid("include.relations");
  const selected = new Map<string, { property: PropertyRow; projection: string[] }[]>();
  for (const [databaseId, properties] of sourceSchemas) {
    const request =
      options.relations === true
        ? Object.fromEntries(properties.filter((p) => p.type === "relation").map((p) => [p.key, []]))
        : options.relations;
    if (Object.keys(request).length > 5) invalid("include.relations");
    selected.set(
      databaseId,
      Object.entries(request).map(([key, projection]) => {
        const property = properties.find((p) => p.key === key && p.type === "relation");
        if (!property) invalid(`include.relations.${key}`);
        if (projection.length > 10) invalid(`include.relations.${key}`);
        return { property, projection };
      }),
    );
  }
  const selections = [...selected.values()].flat();
  const propertyIds = selections.map((entry) => entry.property.id);
  const targetDbIds = [...new Set(selections.map((entry) => targetDatabase(entry.property)))];
  const schemas = await listPropertiesByDatabases(client, targetDbIds);
  for (const { property, projection } of selections) {
    const schema = schemas.get(targetDatabase(property)) ?? [];
    for (const key of projection)
      if (!schema.some((p) => p.key === key)) invalid(`include.relations.${property.key}.${key}`);
  }
  const edges = await client.query<Edge>(
    `WITH ranked AS (SELECT e.id, p.id AS property_id,
     CASE WHEN rd.property_id_a = p.id THEN e.item_a ELSE e.item_b END AS source_id,
     CASE WHEN rd.property_id_a = p.id THEN e.item_b ELSE e.item_a END AS target_id, e.metadata,
     ROW_NUMBER() OVER (PARTITION BY p.id, CASE WHEN rd.property_id_a = p.id THEN e.item_a ELSE e.item_b END
       ORDER BY COALESCE(e.metadata->>'addedAt', e.id::text), e.id) AS target_rank
     FROM properties p JOIN relation_definitions rd ON rd.property_id_a = p.id OR rd.property_id_b = p.id
     JOIN item_relations e ON e.relation_definition_id = rd.id
     JOIN items visible ON visible.id = CASE WHEN rd.property_id_a = p.id THEN e.item_b ELSE e.item_a END
       AND visible.database_id = (p.config->>'targetDatabaseId')::uuid AND visible.deleted_at IS NULL
     JOIN databases visible_db ON visible_db.id = visible.database_id AND visible_db.archived_at IS NULL
     WHERE p.id = ANY($1::uuid[]) AND
       (CASE WHEN rd.property_id_a = p.id THEN e.item_a ELSE e.item_b END) = ANY($2::uuid[])
     ) SELECT id, property_id, source_id, target_id, metadata FROM ranked WHERE target_rank <= 51
     ORDER BY COALESCE(metadata->>'addedAt', id::text), id`,
    [propertyIds, items.map((item) => item.id)],
  );
  const edgeRows = edges.rows.map((row) => ({ ...row, metadata: jsonObject.parse(row.metadata) }));
  const databases = await client.query<{
    id: string;
    key: string | null;
    system: boolean;
    icon: string | null;
    color: string | null;
    owner_module_id: string | null;
  }>(
    "SELECT id, key, system, icon, color, owner_module_id FROM databases WHERE id = ANY($1::uuid[]) AND archived_at IS NULL",
    [targetDbIds],
  );
  const dbs = new Map(databases.rows.map((db) => [db.id, db]));
  const targetRows = await client.query<{
    id: string;
    database_id: string;
    properties: unknown;
    computed: unknown;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT i.id,i.database_id,i.properties,i.computed,i.created_at,i.updated_at FROM items i
     JOIN databases db ON db.id=i.database_id AND db.archived_at IS NULL
     WHERE i.id=ANY($1::uuid[]) AND i.database_id=ANY($2::uuid[]) AND i.deleted_at IS NULL`,
    [[...new Set(edgeRows.map((e) => e.target_id))], targetDbIds],
  );
  const targets = targetRows.rows.map((row) =>
    projectItemForRead(
      {
        id: row.id,
        databaseId: row.database_id,
        properties: jsonObject.parse(row.properties),
        computed: jsonObject.parse(row.computed),
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        deletedAt: null,
      },
      dbs.get(row.database_id)?.owner_module_id ?? null,
    ),
  );
  const byId = new Map(targets.map((item) => [item.id, item]));
  const unreadable = options.unreadableDatabaseIds ?? new Set<string>();
  const hiddenInherited = await hiddenInheritedTargetIds(
    client,
    targets.map((item) => item.id),
    options,
  );
  // A hidden target is neither projected nor looked at again: the reader gets its id and nothing else.
  const readableTargets = targets.filter((item) => !unreadable.has(item.databaseId) && !hiddenInherited.has(item.id));
  const nestedProperties = selections.flatMap(({ property, projection }) =>
    (schemas.get(targetDatabase(property)) ?? []).filter((p) => p.type === "relation" && projection.includes(p.key)),
  );
  const nested = new Map<string, (ReducedRelationTarget | HiddenRelationTarget)[]>();
  if (nestedProperties.length > 0) {
    const result = await client.query<{
      source_id: string;
      property_id: string;
      id: string;
      database_id: string;
      database_key: string | null;
      properties: unknown;
      title_key: string | null;
      system: boolean;
      color: string | null;
      icon: string | null;
      has_color: boolean;
      has_icon: boolean;
    }>(
      `WITH ranked AS (SELECT CASE WHEN rd.property_id_a = p.id THEN e.item_a ELSE e.item_b END AS source_id, p.id AS property_id,
      target.id, target.database_id, db.key AS database_key, target.properties, title.key AS title_key,
      db.system, db.color, db.icon,
      EXISTS(SELECT 1 FROM properties x WHERE x.database_id=db.id AND x.key='color') AS has_color,
      EXISTS(SELECT 1 FROM properties x WHERE x.database_id=db.id AND x.key='icon') AS has_icon,
      ROW_NUMBER() OVER (PARTITION BY p.id, CASE WHEN rd.property_id_a=p.id THEN e.item_a ELSE e.item_b END
        ORDER BY COALESCE(e.metadata->>'addedAt', e.id::text), e.id) AS target_rank
      FROM properties p JOIN relation_definitions rd ON rd.property_id_a=p.id OR rd.property_id_b=p.id
      JOIN item_relations e ON e.relation_definition_id=rd.id
      JOIN items target ON target.id=(CASE WHEN rd.property_id_a=p.id THEN e.item_b ELSE e.item_a END)
      JOIN databases db ON db.id=target.database_id AND db.archived_at IS NULL
      AND target.database_id=(p.config->>'targetDatabaseId')::uuid
      LEFT JOIN properties title ON title.database_id=db.id AND title.type='title'
      WHERE p.id=ANY($1::uuid[]) AND target.deleted_at IS NULL
      AND (CASE WHEN rd.property_id_a=p.id THEN e.item_a ELSE e.item_b END)=ANY($2::uuid[])
      ) SELECT * FROM ranked WHERE target_rank <= 50 ORDER BY target_rank`,
      [nestedProperties.map((p) => p.id), readableTargets.map((item) => item.id)],
    );
    const nestedHiddenInherited = await hiddenInheritedTargetIds(
      client,
      result.rows.map((row) => row.id),
      options,
    );
    for (const row of result.rows) {
      const key = `${row.source_id}:${row.property_id}`;
      const values = nested.get(key) ?? [];
      if (unreadable.has(row.database_id) || nestedHiddenInherited.has(row.id)) {
        if (values.length < 50) values.push({ id: row.id, hidden: true });
        nested.set(key, values);
        continue;
      }
      const properties = jsonObject.parse(row.properties);
      const fallback = options.resolver.resolve({
        key: row.database_key,
        system: row.system,
        color: row.color,
        icon: row.icon,
      });
      const reduced: ReducedRelationTarget = {
        id: row.id,
        databaseKey: row.database_key,
        title:
          typeof properties[row.title_key ?? "name"] === "string" ? String(properties[row.title_key ?? "name"]) : "",
      };
      for (const key of ["color", "icon"] as const) {
        const has = key === "color" ? row.has_color : row.has_icon;
        const own = has ? properties[key] : undefined;
        const value = typeof own === "string" && own.trim() !== "" ? own : fallback[key];
        if (typeof value === "string" && value !== "") reduced[key] = value;
      }
      if (values.length < 50) values.push(reduced);
      nested.set(key, values);
    }
  }
  const blobItems = readableTargets.map((item) => ({
    ...item,
    properties: Object.fromEntries(
      selections
        .filter((s) => targetDatabase(s.property) === item.databaseId)
        .flatMap((s) => s.projection)
        .map((key) => [key, item.properties[key]]),
    ),
  }));
  const wanted: { itemId: string; key: string; id: string }[] = [];
  for (const item of blobItems) {
    for (const property of schemas.get(item.databaseId) ?? []) {
      if (property.type !== "file" && property.type !== "image") continue;
      const value = item.properties[property.key];
      if (typeof value !== "object" || value === null || !("blobId" in value)) continue;
      if (
        typeof value.blobId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.blobId)
      )
        continue;
      wanted.push({ itemId: item.id, key: property.key, id: value.blobId });
    }
  }
  const blobRows = await client.query<{ id: string; byte_size: number; mime_type: string; filename: string | null }>(
    `SELECT id, byte_size::double precision AS byte_size, mime_type,
      (regexp_match(substring(storage_key FROM '[^/]+$'), '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}-(.+)$'))[1] AS filename
     FROM blobs WHERE id=ANY($1::uuid[])`,
    [[...new Set(wanted.map((entry) => entry.id))]],
  );
  const blobs = new Map<string, NonNullable<ExpandedRelationTarget["blobs"]>>();
  const byBlobId = new Map(blobRows.rows.map((row) => [row.id, row]));
  for (const entry of wanted) {
    const row = byBlobId.get(entry.id);
    if (!row) continue;
    const metadata = blobs.get(entry.itemId) ?? {};
    metadata[entry.key] = { blobId: row.id, byteSize: row.byte_size, mimeType: row.mime_type, filename: row.filename };
    blobs.set(entry.itemId, metadata);
  }
  return items.map((item) => {
    const relations: Record<string, ItemRelationTarget[]> = {};
    const relationsTruncated: string[] = [];
    for (const { property, projection } of selected.get(item.databaseId) ?? []) {
      const visible = edgeRows.filter(
        (edge) =>
          edge.source_id === item.id &&
          edge.property_id === property.id &&
          byId.get(edge.target_id)?.databaseId === targetDatabase(property),
      );
      if (visible.length > 50) relationsTruncated.push(property.key);
      relations[property.key] = visible.slice(0, 50).map((edge): ItemRelationTarget => {
        const target = byId.get(edge.target_id)!;
        if (unreadable.has(target.databaseId) || hiddenInherited.has(target.id)) return { id: target.id, hidden: true };
        const db = dbs.get(target.databaseId)!;
        const schema = schemas.get(target.databaseId) ?? [];
        const titleKey = schema.find((p) => p.type === "title")?.key ?? "name";
        const targetBlobs = Object.fromEntries(
          Object.entries(blobs.get(target.id) ?? {}).filter(([key]) => projection.includes(key)),
        );
        const values = Object.fromEntries(
          projection.map((key) => {
            const p = schema.find((p) => p.key === key)!;
            return [
              key,
              p.type === "relation" ? (nested.get(`${target.id}:${p.id}`) ?? []) : (target.properties[key] ?? null),
            ];
          }),
        );
        const fallback = options.resolver.resolve(db);
        const look: { color?: string; icon?: string } = {};
        for (const key of ["color", "icon"] as const) {
          const value = schema.some((p) => p.key === key) ? target.properties[key] : undefined;
          const resolved = typeof value === "string" && value.trim() !== "" ? value : fallback[key];
          if (typeof resolved === "string" && resolved !== "") look[key] = resolved;
        }
        return {
          id: target.id,
          databaseId: target.databaseId,
          databaseKey: db.key,
          title: typeof target.properties[titleKey] === "string" ? String(target.properties[titleKey]) : "",
          ...look,
          metadata: edge.metadata,
          ...(projection.length ? { properties: values } : {}),
          ...(Object.keys(targetBlobs).length ? { blobs: targetBlobs } : {}),
        };
      });
    }
    return { ...item, relations, relationsTruncated };
  });
}
