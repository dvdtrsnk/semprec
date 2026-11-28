import type { ModuleLinkRuleProjection } from "@alldots/module-registry";
import type { RelationEdgeChangedHookContext } from "../chokePoint/hooks.js";
import { lockItemById } from "../chokePoint/itemsStore.js";
import {
  addValueLinkItemSource,
  deleteEmptyValueLink,
  insertValueLink,
  listOnValueLinkSourceItemIds,
  listValueLinkSourcesByLinkIds,
  lockValueLink,
  removeValueLinkItemSource,
} from "../chokePoint/valueLinksStore.js";
import { loadLinkRules, resolveLinkRule, type ResolvedLinkRule } from "./linkRuleCatalog.js";
import {
  applyInheritedValues,
  enqueueLinkPropagation,
  readTargetValues,
  scheduleDownstream,
  sourceUnion,
  targetIsMany,
} from "./linkPropagation.js";
import { enqueueResolverRulesForEdge } from "./linkResolverTriggers.js";
import { currentPropagationHop } from "./propagationContext.js";

/** Both edge hooks read the target from here, so they lock the same row. */
function viaEdgeItems(
  rule: ModuleLinkRuleProjection,
  resolved: ResolvedLinkRule,
  context: Pick<RelationEdgeChangedHookContext, "itemA" | "itemB">,
): { viaItem: string; otherItem: string; targetId: string } {
  const viaIsSideA = resolved.viaDefinition.propertyIdA === resolved.viaProperty.id;
  const viaItem = viaIsSideA ? context.itemA : context.itemB;
  const otherItem = viaIsSideA ? context.itemB : context.itemA;
  return { viaItem, otherItem, targetId: rule.via.databaseKey === rule.target.databaseKey ? viaItem : otherItem };
}

/**
 * Locks the target item of each rule whose via relation is the written edge's, in catalog order, and nothing else.
 * A user or agent edge write runs it before ending an edge side's `on` link, so the item row is locked before the
 * link row, as in the propagation job. A `system` writer never ends a link and takes no lock.
 */
export async function linkRuleEdgeLockHook(context: RelationEdgeChangedHookContext): Promise<void> {
  if (context.op === "update" || context.writer.writerKind === "system") return;
  for (const rule of await loadLinkRules()) {
    const resolved = await resolveLinkRule(context.client, rule);
    if (!resolved || resolved.viaDefinition.id !== context.relationDefinitionId) continue;
    await lockItemById(context.client, resolved.targetDatabase.id, viaEdgeItems(rule, resolved, context).targetId);
  }
}

export async function linkRuleEdgeHook(context: RelationEdgeChangedHookContext): Promise<void> {
  if (context.op === "update") return;
  // The hop of the `valueLinks` write this change belongs to; `null` for any other writer.
  const inheritedWriteHop = context.writer.writerKind === "system" ? currentPropagationHop(context.client) : null;
  const hop = inheritedWriteHop ?? 0;
  await enqueueResolverRulesForEdge(context, hop);
  for (const rule of await loadLinkRules()) {
    const resolved = await resolveLinkRule(context.client, rule);
    if (!resolved) continue;
    if (resolved.sourceDefinition?.id === context.relationDefinitionId) {
      const sourceId =
        resolved.sourceDefinition.propertyIdA === resolved.sourceProperty.id ? context.itemA : context.itemB;
      await enqueueLinkPropagation(context.client, rule.key, sourceId, hop + 1);
    }
    if (resolved.valueFilter?.definition.id === context.relationDefinitionId) {
      // The value filter's relation changed, so every source of an `on` link of the rule is queued for recompute. The
      // filter row is locked first, which waits for every copy that read the relation before this change
      // (`readOmittedItemIds`), so the links those copies commit are among the ones queued.
      const filter = resolved.valueFilter;
      const holderId = filter.definition.propertyIdA === filter.property.id ? context.itemA : context.itemB;
      await lockItemById(context.client, filter.property.databaseId, holderId);
      for (const sourceId of await listOnValueLinkSourceItemIds(context.client, rule.key))
        await enqueueLinkPropagation(context.client, rule.key, sourceId, hop + 1);
    }
    if (resolved.viaDefinition.id !== context.relationDefinitionId) continue;
    const effectiveHop = hop + 1;
    if (effectiveHop > 5) {
      const sourceId = resolved.viaDefinition.propertyIdA === resolved.viaProperty.id ? context.itemA : context.itemB;
      await enqueueLinkPropagation(context.client, rule.key, sourceId, effectiveHop);
      continue;
    }
    const { viaItem, otherItem, targetId } = viaEdgeItems(rule, resolved, context);
    const sourceId = rule.via.databaseKey === rule.source.databaseKey ? viaItem : otherItem;
    const target = await lockItemById(context.client, resolved.targetDatabase.id, targetId);
    if (!target || target.deletedAt) continue;
    let link = await lockValueLink(context.client, targetId, resolved.targetProperty.key);
    if (link && (link.state !== "on" || link.ruleKey !== rule.key)) continue;
    if (context.op === "create") {
      if (!link) {
        if ((await readTargetValues(context.client, resolved, targetId)).length > 0) continue;
        const values = await sourceUnion(context.client, resolved, [sourceId]);
        if (!targetIsMany(resolved) && values.length > 1) continue;
        link = (
          await insertValueLink(context.client, {
            itemId: targetId,
            propertyKey: rule.target.propertyKey,
            ruleKey: rule.key,
            sources: [{ kind: "item", sourceItemId: sourceId, sourcePropertyKey: rule.source.propertyKey }],
          })
        ).link;
      } else {
        await addValueLinkItemSource(context.client, link.id, sourceId, rule.source.propertyKey);
      }
    } else {
      if (!link || !(await removeValueLinkItemSource(context.client, link.id, sourceId, rule.source.propertyKey)))
        continue;
      const sources = await listValueLinkSourcesByLinkIds(context.client, [link.id]);
      if (sources.length === 0) {
        // A via edge removed by the `valueLinks` process is an inherited value being replaced, not a disconnect: its value
        // goes too, while the link is still `on`. Removed by anyone else, the value stays the target's own.
        if (inheritedWriteHop !== null)
          await applyInheritedValues(context.client, resolved, targetId, [], effectiveHop);
        if (!(await deleteEmptyValueLink(context.client, link.id)))
          throw new Error("Value link changed during removal");
        continue;
      }
    }
    const sources = await listValueLinkSourcesByLinkIds(context.client, [link.id]);
    const ids = sources.flatMap((source) => (source.kind === "item" ? [source.sourceItemId] : []));
    const values = await sourceUnion(context.client, resolved, ids);
    const changed = await applyInheritedValues(context.client, resolved, targetId, values, effectiveHop);
    if (!changed)
      await scheduleDownstream(
        context.client,
        rule.target.databaseKey,
        rule.target.propertyKey,
        targetId,
        effectiveHop + 1,
      );
  }
}
