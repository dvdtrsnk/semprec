import type { ItemCreateHook, ItemRestoreHook, ItemUpdateHookContext } from "../chokePoint/hooks.js";
import { loadLinkRules } from "./linkRuleCatalog.js";
import { enqueueLinkPropagation } from "./linkPropagation.js";
import {
  enqueueResolverRulesForItemUpdate,
  enqueueResolverRulesForWrittenProperties,
  holdingProperties,
} from "./linkResolverTriggers.js";
import { currentPropagationHop } from "./propagationContext.js";

export async function linkRuleItemHook(context: ItemUpdateHookContext): Promise<void> {
  const databaseKey = context.database.key;
  if (!databaseKey) return;
  const hop = context.writer.writerKind === "system" ? (currentPropagationHop(context.client) ?? 0) : 0;
  await enqueueResolverRulesForItemUpdate(context, hop);
  for (const rule of await loadLinkRules()) {
    if (rule.source.databaseKey === databaseKey && Object.hasOwn(context.propertiesPatch, rule.source.propertyKey)) {
      await enqueueLinkPropagation(context.client, rule.key, context.item.id, hop + 1);
    }
  }
}

/**
 * A created item brings its properties to the resolver rules that declare them as inputs for an item that appears
 * (`onAppear`), as an update of them would: a company created with a `web` can be the company of threads that were
 * ingested before it existed.
 */
export const linkRuleItemCreateHook: ItemCreateHook = async (context) => {
  const databaseKey = context.database.key;
  if (!databaseKey) return;
  const hop = context.writer.writerKind === "system" ? (currentPropagationHop(context.client) ?? 0) : 0;
  await enqueueResolverRulesForWrittenProperties(
    context.client,
    databaseKey,
    context.item.id,
    holdingProperties(context.properties),
    hop,
    true,
  );
};

/** A restored item appears again for the resolver rules: its properties count again from now on. */
export const linkRuleItemRestoreHook: ItemRestoreHook = async (context) => {
  const databaseKey = context.database.key;
  if (!databaseKey) return;
  const hop = context.writerKind === "system" ? (currentPropagationHop(context.client) ?? 0) : 0;
  await enqueueResolverRulesForWrittenProperties(
    context.client,
    databaseKey,
    context.item.id,
    holdingProperties(context.item.properties),
    hop,
    true,
  );
};
