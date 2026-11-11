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
import { loadLinkRules, resolveLinkRule } from "./linkRuleCatalog.js";
import {
  applyInheritedValues,
  enqueueLinkPropagation,
  readTargetValues,
  scheduleDownstream,
  sourceUnion,
  targetIsMany,
} from "./linkPropagation.js";
import { currentPropagationHop } from "./propagationContext.js";

export async function linkRuleEdgeHook(context: RelationEdgeChangedHookContext): Promise<void> {
  if (context.op === "update") return;
  // The hop of the `valueLinks` write this edge change belongs to: a propagated value or a relink on this
  // client. `null` for an edge any other writer changed.
  const inheritedWriteHop = context.writer.writerKind === "system" ? currentPropagationHop(context.client) : null;
  const hop = inheritedWriteHop ?? 0;
  for (const rule of await loadLinkRules()) {
    const resolved = await resolveLinkRule(context.client, rule);
    if (!resolved) continue;
    if (resolved.sourceDefinition?.id === context.relationDefinitionId) {
      const sourceId =
        resolved.sourceDefinition.propertyIdA === resolved.sourceProperty.id ? context.itemA : context.itemB;
      await enqueueLinkPropagation(context.client, rule.key, sourceId, hop + 1);
    }
    if (resolved.valueFilter?.definition.id === context.relationDefinitionId) {
      // The relation the rule's value filter names gained or lost an edge, so an item is left out from now on or
      // no longer is. The values copied so far were filtered as the relation was then: every source of an `on`
      // link of the rule is queued, and the job recomputes those links with the filter as this transaction
      // commits it. The filter's row is locked first, which waits for every copy that read the relation before
      // this change (`readOmittedItemIds`), so the links those copies commit are among the ones queued here.
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
    const viaItem = resolved.viaDefinition.propertyIdA === resolved.viaProperty.id ? context.itemA : context.itemB;
    const otherItem = resolved.viaDefinition.propertyIdA === resolved.viaProperty.id ? context.itemB : context.itemA;
    const targetId = rule.via.databaseKey === rule.target.databaseKey ? viaItem : otherItem;
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
        // A via edge the `valueLinks` process removed was itself an inherited value that is being replaced or
        // cleared, not a disconnect. The value it carried goes with it, written while the link is still `on`, so
        // the via edge that process writes next finds an empty target and links it to the new source. A via edge
        // removed by a user, an agent or another system process keeps the value as the target's own.
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
