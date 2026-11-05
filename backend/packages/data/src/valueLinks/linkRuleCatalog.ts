import type { PoolClient } from "pg";
import type { ModuleLinkRuleProjection } from "@semprec/module-registry";
import { getDatabaseByKey } from "../chokePoint/databasesStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId } from "../chokePoint/relationsStore.js";
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
}

/** Resolves a rule afresh within the caller's tenant transaction. */
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
  };
}
