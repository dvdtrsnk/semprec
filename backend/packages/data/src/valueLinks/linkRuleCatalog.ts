import type { PoolClient } from "pg";
import type { ModuleLinkRuleEndpoint, ModuleLinkRuleProjection } from "@semprec/module-registry";
import { getDatabaseByKey, getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { lockAllItemsInDatabaseForShare } from "../chokePoint/itemsStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import type { DatabaseRow, PropertyRow, RelationDefinitionRow } from "../types.js";

let rulesPromise: Promise<ModuleLinkRuleProjection[]> | undefined;

export function loadLinkRules(): Promise<ModuleLinkRuleProjection[]> {
  rulesPromise ??= loadFullModuleRegistry()
    .then((registry) => registry.getLinkRules())
    .catch((error: unknown) => {
      rulesPromise = undefined;
      throw error;
    });
  return rulesPromise;
}

/** The relation property a rule's `valueFilter.omit` names, with its relation definition. */
export interface ResolvedValueFilter {
  property: PropertyRow;
  definition: RelationDefinitionRow;
}

export interface ResolvedLinkRule {
  rule: ModuleLinkRuleProjection;
  sourceDatabase: DatabaseRow;
  targetDatabase: DatabaseRow;
  sourceProperty: PropertyRow;
  targetProperty: PropertyRow;
  viaProperty: PropertyRow;
  viaDefinition: RelationDefinitionRow;
  sourceDefinition: RelationDefinitionRow | null;
  targetDefinition: RelationDefinitionRow | null;
  /** The rule's resolved `valueFilter`; `null` for a rule that declares none. */
  valueFilter: ResolvedValueFilter | null;
}

/**
 * Resolves a `valueFilter.omit` endpoint within the caller's tenant transaction (issue #1697). The
 * database is the system database whose owner module id is `omit.databaseKey`. Returns `null` when
 * that database or the property is missing, or the property is not a relation with a definition.
 */
export async function resolveValueFilter(
  client: PoolClient,
  omit: ModuleLinkRuleEndpoint,
): Promise<ResolvedValueFilter | null> {
  const database = await getDatabaseByModuleId(client, omit.databaseKey);
  if (!database) return null;
  const property = await getPropertyByKey(client, database.id, omit.propertyKey);
  if (!property || property.type !== "relation") return null;
  const definition = await getRelationDefinitionByPropertyId(client, property.id);
  return definition ? { property, definition } : null;
}

/**
 * The ids a resolved value filter leaves out: every item its relation connects to a row of the
 * property's database, a trashed row included. It reads all rows of that database and the edges of
 * each, which a filter keeps small by naming a singleton database. No edge (for example no own
 * person chosen) leaves nothing out.
 *
 * The rows are locked `FOR SHARE` before their edges are read, and the lock is held until the caller's
 * transaction ends. A change of the filter's relation locks its row `FOR UPDATE`: `setSelfPersonId`
 * before it writes, the link rule edge hook for any other writer before it queues the recomputation. So
 * a caller at READ COMMITTED either reads the relation as that change committed it, or commits its copy
 * before the change looks for the links to recompute.
 */
export async function readOmittedItemIds(client: PoolClient, filter: ResolvedValueFilter): Promise<string[]> {
  const omitted: string[] = [];
  for (const holder of await lockAllItemsInDatabaseForShare(client, filter.property.databaseId))
    for (const edge of await listRelationsForItem(client, filter.definition.id, holder.id))
      omitted.push(otherSide(edge, holder.id));
  return omitted;
}

/**
 * Resolves a rule afresh within the caller's tenant transaction. A rule whose `valueFilter` cannot
 * be resolved is unresolved as a whole (`null`), so its values are never copied unfiltered.
 */
export async function resolveLinkRule(
  client: PoolClient,
  rule: ModuleLinkRuleProjection,
): Promise<ResolvedLinkRule | null> {
  const sourceDatabase = await getDatabaseByKey(client, rule.source.databaseKey);
  const targetDatabase = await getDatabaseByKey(client, rule.target.databaseKey);
  if (!sourceDatabase || !targetDatabase) return null;
  const viaDatabase = rule.via.databaseKey === rule.source.databaseKey ? sourceDatabase : targetDatabase;
  const sourceProperty = await getPropertyByKey(client, sourceDatabase.id, rule.source.propertyKey);
  const targetProperty = await getPropertyByKey(client, targetDatabase.id, rule.target.propertyKey);
  const viaProperty = await getPropertyByKey(client, viaDatabase.id, rule.via.relationKey);
  if (!sourceProperty || !targetProperty || !viaProperty || viaProperty.type !== "relation") return null;
  const viaDefinition = await getRelationDefinitionByPropertyId(client, viaProperty.id);
  const otherDatabase = viaDatabase.id === sourceDatabase.id ? targetDatabase : sourceDatabase;
  if (!viaDefinition || viaProperty.config.targetDatabaseId !== otherDatabase.id) return null;
  const sourceDefinition =
    sourceProperty.type === "relation" ? await getRelationDefinitionByPropertyId(client, sourceProperty.id) : null;
  const targetDefinition =
    targetProperty.type === "relation" ? await getRelationDefinitionByPropertyId(client, targetProperty.id) : null;
  if (
    (sourceProperty.type === "relation" && !sourceDefinition) ||
    (targetProperty.type === "relation" && !targetDefinition)
  )
    return null;
  const valueFilter = rule.valueFilter ? await resolveValueFilter(client, rule.valueFilter.omit) : null;
  if (rule.valueFilter && !valueFilter) return null;
  return {
    rule,
    sourceDatabase,
    targetDatabase,
    sourceProperty,
    targetProperty,
    viaProperty,
    viaDefinition,
    sourceDefinition,
    targetDefinition,
    valueFilter,
  };
}
