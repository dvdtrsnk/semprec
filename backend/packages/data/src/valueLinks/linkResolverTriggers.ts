import type { PoolClient } from "pg";
import type { ItemUpdateHookContext, RelationEdgeChangedHookContext } from "../chokePoint/hooks.js";
import { getDatabase } from "../chokePoint/databasesStore.js";
import { getProperty } from "../chokePoint/propertiesStore.js";
import { getRelationDefinition } from "../chokePoint/relationsStore.js";
import { loadResolverLinkRules } from "./linkResolver.js";
import { enqueueLinkPropagation } from "./linkPropagation.js";

/** One job per declaring rule and per declared edge side, for that side's item, at budget `hop + 1`. */
export async function enqueueResolverRulesForEdge(context: RelationEdgeChangedHookContext, hop: number): Promise<void> {
  const rules = await loadResolverLinkRules();
  if (!rules.some((rule) => rule.resolver.inputs.edges.length > 0)) return;
  const definition = await getRelationDefinition(context.client, context.relationDefinitionId);
  if (!definition) return;
  const sides = [
    { propertyId: definition.propertyIdA, itemId: context.itemA },
    ...(definition.propertyIdB ? [{ propertyId: definition.propertyIdB, itemId: context.itemB }] : []),
  ];
  for (const side of sides) {
    const property = await getProperty(context.client, side.propertyId);
    const database = property ? await getDatabase(context.client, property.databaseId) : null;
    if (!property || !database?.key) continue;
    for (const rule of rules) {
      const declared = rule.resolver.inputs.edges.some(
        (edge) => edge.databaseKey === database.key && edge.relationKey === property.key,
      );
      if (declared) await enqueueLinkPropagation(context.client, rule.key, side.itemId, hop + 1);
    }
  }
}

/** At budget `hop + 1`; for an appearing (created or restored) item only `onAppear` properties count. */
export async function enqueueResolverRulesForWrittenProperties(
  client: PoolClient,
  databaseKey: string,
  itemId: string,
  written: Record<string, unknown>,
  hop: number,
  appearing = false,
): Promise<void> {
  for (const rule of await loadResolverLinkRules()) {
    const declared = rule.resolver.inputs.properties.some(
      (property) =>
        property.databaseKey === databaseKey &&
        Object.hasOwn(written, property.propertyKey) &&
        (!appearing || property.onAppear === true),
    );
    if (declared) await enqueueLinkPropagation(client, rule.key, itemId, hop + 1);
  }
}

/** What a created or restored item brings to its rules. */
export function holdingProperties(properties: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== null && value !== undefined));
}

export async function enqueueResolverRulesForItemUpdate(context: ItemUpdateHookContext, hop: number): Promise<void> {
  const databaseKey = context.database.key;
  if (!databaseKey) return;
  await enqueueResolverRulesForWrittenProperties(
    context.client,
    databaseKey,
    context.item.id,
    context.propertiesPatch,
    hop,
  );
}
