import type { ItemUpdateHookContext } from "../chokePoint/hooks.js";
import { loadLinkRules } from "./linkRuleCatalog.js";
import { enqueueLinkPropagation } from "./linkPropagation.js";
import { currentPropagationHop } from "./propagationContext.js";

export async function linkRuleItemHook(context: ItemUpdateHookContext): Promise<void> {
  const databaseKey = context.database.key;
  if (!databaseKey) return;
  const hop = context.writer.writerKind === "system" ? (currentPropagationHop(context.client) ?? 0) : 0;
  for (const rule of await loadLinkRules()) {
    if (rule.source.databaseKey === databaseKey && Object.hasOwn(context.propertiesPatch, rule.source.propertyKey)) {
      await enqueueLinkPropagation(context.client, rule.key, context.item.id, hop + 1);
    }
  }
}
