import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { createLogger, currentTenantScope, TenantScopeMissingError } from "@semprec/shared";
import { withTransaction, runAfterCommit } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";
import { tenantLane } from "../tenancy/tenantLane.js";
import { getItemById, getItemsByIds, lockItemById } from "../chokePoint/itemsStore.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { createRelationWithClient, deleteRelationWithClient } from "../chokePoint/relationOps.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import {
  deleteEmptyValueLink,
  insertValueLink,
  listValueLinkSourcesByLinkIds,
  lockValueLink,
  pageValueLinksForSource,
  reactivateValueLink,
  replaceValueLinkSources,
  type ValueLinkRow,
} from "../chokePoint/valueLinksStore.js";
import { getDatabaseByKey } from "../chokePoint/databasesStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { VALUE_LINKS_OWNER_PROCESS } from "../chokePoint/valueLinkWrites.js";
import { loadLinkRules, readOmittedItemIds, resolveLinkRule, type ResolvedLinkRule } from "./linkRuleCatalog.js";
import { loadResolverLinkRules, type ResolverLinkRule } from "./linkResolver.js";
import { withPropagationHop } from "./propagationContext.js";

const payloadSchema = z
  .object({ ruleKey: z.string().min(1), sourceItemId: z.uuid(), hop: z.number().int().min(1).max(5) })
  .strict();
const PAGE_SIZE = 100;
const logger = createLogger("value-links");

export async function enqueueLinkPropagation(
  client: PoolClient,
  ruleKey: string,
  sourceItemId: string,
  hop: number,
): Promise<void> {
  const scope = currentTenantScope();
  if (scope?.kind !== "tenant") throw new TenantScopeMissingError("Value link propagation requires a tenant scope");
  if (hop > 5) {
    logger.warn({ ruleKey, hop }, "Value link propagation hop dropped");
    return;
  }
  const payload = payloadSchema.parse({ ruleKey, sourceItemId, hop });
  await enqueueJob(client, CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE, payload, {
    jobKey: `valueLinksPropagate:${scope.tenantId}:${ruleKey}:${sourceItemId}:${hop}`,
    queueName: tenantLane("value-links"),
    maxAttempts: 3,
  });
}

export async function scheduleDownstream(
  client: PoolClient,
  databaseKey: string,
  propertyKey: string,
  itemId: string,
  hop: number,
): Promise<void> {
  for (const rule of await loadLinkRules()) {
    if (rule.source.databaseKey === databaseKey && rule.source.propertyKey === propertyKey)
      await enqueueLinkPropagation(client, rule.key, itemId, hop);
  }
}

function distinct(values: unknown[]): unknown[] {
  const result: unknown[] = [];
  for (const value of values) if (!result.some((existing) => isDeepStrictEqual(existing, value))) result.push(value);
  return result;
}

export type LinkRuleTarget = Pick<ResolvedLinkRule, "targetDatabase" | "targetProperty" | "targetDefinition">;

export function targetIsMany(resolved: Pick<ResolvedLinkRule, "targetProperty" | "targetDefinition">): boolean {
  const def = resolved.targetDefinition;
  if (!def) return resolved.targetProperty.type === "multi_select";
  return (
    def.cardinality === "many_to_many" ||
    (def.cardinality === "one_to_many" && def.propertyIdA === resolved.targetProperty.id)
  );
}

export async function readRuleValues(
  client: PoolClient,
  databaseId: string,
  itemId: string,
  property: ResolvedLinkRule["sourceProperty"],
  definition: ResolvedLinkRule["sourceDefinition"],
): Promise<unknown[]> {
  const item = await getItemById(client, databaseId, itemId);
  if (!item || item.deletedAt) return [];
  if (definition)
    return (await listRelationsForItem(client, definition.id, itemId)).map((edge) => otherSide(edge, itemId));
  const value = item.properties[property.key];
  if (value === undefined || value === null || value === "") return [];
  return property.type === "multi_select" && Array.isArray(value) ? z.array(z.unknown()).parse(value) : [value];
}

export async function readTargetValues(
  client: PoolClient,
  resolved: LinkRuleTarget,
  itemId: string,
): Promise<unknown[]> {
  return readRuleValues(client, resolved.targetDatabase.id, itemId, resolved.targetProperty, resolved.targetDefinition);
}

/**
 * The distinct values the sources give a rule's target, minus `valueFilter` items and trashed relation sources: a
 * relation write refuses a trashed endpoint, so copying one would fail the whole write.
 */
export async function sourceUnion(client: PoolClient, resolved: ResolvedLinkRule, ids: string[]): Promise<unknown[]> {
  const values: unknown[] = [];
  for (const id of ids)
    values.push(
      ...(await readRuleValues(
        client,
        resolved.sourceDatabase.id,
        id,
        resolved.sourceProperty,
        resolved.sourceDefinition,
      )),
    );
  let union = distinct(values);
  if (resolved.sourceDefinition) {
    const live = new Set((await getItemsByIds(client, z.array(z.uuid()).parse(union))).map((item) => item.id));
    union = union.filter((value) => typeof value === "string" && live.has(value));
  }
  if (!resolved.valueFilter) return union;
  const omitted: unknown[] = await readOmittedItemIds(client, resolved.valueFilter);
  return union.filter((value) => !omitted.includes(value));
}

export async function applyInheritedValues(
  client: PoolClient,
  resolved: LinkRuleTarget,
  itemId: string,
  values: unknown[],
  hop: number,
): Promise<boolean> {
  if (!targetIsMany(resolved) && values.length > 1) return false;
  const current = await readTargetValues(client, resolved, itemId);
  const same =
    current.length === values.length &&
    current.every((entry) => values.some((other) => isDeepStrictEqual(entry, other)));
  if (same) return false;
  await withPropagationHop(client, hop, async () => {
    if (resolved.targetDefinition) {
      const wanted = z.array(z.uuid()).parse(values);
      const existing = z.array(z.uuid()).parse(current);
      for (const id of existing.filter((id) => !wanted.includes(id)))
        await deleteRelationWithClient(
          client,
          { relationPropertyId: resolved.targetProperty.id, callerItemId: itemId, targetItemId: id },
          { ownerProcess: VALUE_LINKS_OWNER_PROCESS },
        );
      for (const id of wanted.filter((id) => !existing.includes(id)))
        await createRelationWithClient(
          client,
          { relationPropertyId: resolved.targetProperty.id, callerItemId: itemId, targetItemId: id },
          { ownerProcess: VALUE_LINKS_OWNER_PROCESS },
        );
      const target = await getItemById(client, resolved.targetDatabase.id, itemId);
      if (target)
        runAfterCommit(client, () =>
          notifyInvalidation({
            scope: "item",
            databaseId: target.databaseId,
            itemId: target.id,
            op: "update",
            updatedAt: target.updatedAt,
          }),
        );
    } else {
      const value = targetIsMany(resolved) ? values : (values[0] ?? null);
      await updateItemWithClient(
        client,
        { databaseId: resolved.targetDatabase.id, itemId, propertiesPatch: { [resolved.targetProperty.key]: value } },
        { systemOwnerProcess: VALUE_LINKS_OWNER_PROCESS },
      );
    }
  });
  return true;
}

export async function handleLinkPropagation(pool: Pool, raw: unknown): Promise<void> {
  const payload = payloadSchema.parse(raw);
  const resolverRule = (await loadResolverLinkRules()).find((entry) => entry.key === payload.ruleKey);
  if (resolverRule) return propagateResolverRule(pool, resolverRule, payload.sourceItemId, payload.hop);
  const rule = (await loadLinkRules()).find((entry) => entry.key === payload.ruleKey);
  if (!rule) throw new Error("Value link rule is unavailable");
  let afterId: string | null = null;
  for (;;) {
    const page = await withTransaction(pool, async (client) => {
      const resolved = await resolveLinkRule(client, rule);
      if (!resolved) return { last: null, count: 0 };
      const links = await pageValueLinksForSource(client, {
        ruleKey: rule.key,
        sourceItemId: payload.sourceItemId,
        afterId,
        limit: PAGE_SIZE,
      });
      for (const candidate of [...links].sort((a, b) => a.itemId.localeCompare(b.itemId))) {
        const target = await lockItemById(client, resolved.targetDatabase.id, candidate.itemId);
        if (!target || target.deletedAt) continue;
        const link = await lockValueLink(client, target.id, resolved.targetProperty.key);
        if (!link || link.id !== candidate.id || link.state !== "on" || link.ruleKey !== rule.key) continue;
        const sources = await listValueLinkSourcesByLinkIds(client, [link.id]);
        const ids = sources
          .filter((source) => source.kind === "item" && source.sourcePropertyKey === rule.source.propertyKey)
          .map((source) => (source.kind === "item" ? source.sourceItemId : ""));
        if (!ids.includes(payload.sourceItemId)) continue;
        const values = await sourceUnion(client, resolved, ids);
        const changed = await applyInheritedValues(client, resolved, target.id, values, payload.hop);
        if (!changed)
          await scheduleDownstream(
            client,
            rule.target.databaseKey,
            rule.target.propertyKey,
            target.id,
            payload.hop + 1,
          );
      }
      return { last: links.at(-1)?.id ?? null, count: links.length };
    });
    if (page.count < PAGE_SIZE || !page.last) return;
    afterId = page.last;
  }
}

/** A relation property of a database, resolved in the caller's tenant. */
export async function resolveResolverTarget(
  client: PoolClient,
  rule: ResolverLinkRule,
): Promise<LinkRuleTarget | null> {
  const targetDatabase = await getDatabaseByKey(client, rule.target.databaseKey);
  if (!targetDatabase) return null;
  const targetProperty = await getPropertyByKey(client, targetDatabase.id, rule.target.propertyKey);
  if (targetProperty?.type !== "relation") return null;
  const targetDefinition = await getRelationDefinitionByPropertyId(client, targetProperty.id);
  return targetDefinition ? { targetDatabase, targetProperty, targetDefinition } : null;
}

function announceItem(client: PoolClient, item: { id: string; databaseId: string; updatedAt: string }): void {
  runAfterCommit(client, () =>
    notifyInvalidation({
      scope: "item",
      databaseId: item.databaseId,
      itemId: item.id,
      op: "update",
      updatedAt: item.updatedAt,
    }),
  );
}

/**
 * Brings the target property in line with the resolver, locking the item first and then its link row (as the edge
 * hook and propagation job do). A `broken` link or one of another rule is left alone. Without a link, an existing
 * value stays the item's own and an empty resolution writes nothing; otherwise the link is created `on` first. An
 * empty resolution of an `on` link removes the value while still `on`, then the link. A sources-only change is still
 * announced so clients refetch links.
 */
export async function evaluateResolverRule(
  client: PoolClient,
  rule: ResolverLinkRule,
  itemId: string,
  hop: number,
): Promise<void> {
  const target = await resolveResolverTarget(client, rule);
  if (!target) return;
  const item = await lockItemById(client, target.targetDatabase.id, itemId);
  if (!item || item.deletedAt) return;
  let link = await lockValueLink(client, itemId, rule.target.propertyKey);
  if (link && (link.state !== "on" || link.ruleKey !== rule.key)) return;
  const resolution = await rule.resolver.resolve(client, itemId);
  let sourcesChanged: boolean;
  if (!link) {
    if (resolution.values.length === 0) return;
    if ((await readTargetValues(client, target, itemId)).length > 0) return;
    link = (
      await insertValueLink(client, {
        itemId,
        propertyKey: rule.target.propertyKey,
        ruleKey: rule.key,
        sources: resolution.sources,
      })
    ).link;
    sourcesChanged = true;
  } else {
    sourcesChanged = await replaceValueLinkSources(client, link.id, resolution.sources);
  }
  const changed = await applyInheritedValues(client, target, itemId, resolution.values, hop);
  if (resolution.values.length === 0 && !(await deleteEmptyValueLink(client, link.id)))
    throw new Error("Value link changed during removal");
  if (sourcesChanged && !changed) announceItem(client, item);
}

/**
 * Returns `false`, changing nothing, when the resolver has no value for the item, since there is nothing to follow.
 * The caller has locked the item and the link.
 */
export async function relinkResolverLink(
  client: PoolClient,
  rule: ResolverLinkRule,
  link: ValueLinkRow,
): Promise<boolean> {
  const target = await resolveResolverTarget(client, rule);
  if (!target) return false;
  const resolution = await rule.resolver.resolve(client, link.itemId);
  if (resolution.values.length === 0) return false;
  await replaceValueLinkSources(client, link.id, resolution.sources);
  await reactivateValueLink(client, link.id);
  await applyInheritedValues(client, target, link.itemId, resolution.values, 0);
  return true;
}

const RESOLVER_PAGE_SIZE = 100;

/** Re-evaluates affected items, `RESOLVER_PAGE_SIZE` per committed transaction, in ascending id order. */
export async function propagateResolverRule(
  pool: Pool,
  rule: ResolverLinkRule,
  changedItemId: string,
  hop: number,
): Promise<void> {
  let afterId: string | null = null;
  for (;;) {
    const ids: string[] = await withTransaction(pool, async (client) => {
      const page = await rule.resolver.affectedItemIds(client, changedItemId, afterId, RESOLVER_PAGE_SIZE);
      for (const id of page) await evaluateResolverRule(client, rule, id, hop);
      return page;
    });
    const last = ids.at(-1);
    if (ids.length < RESOLVER_PAGE_SIZE || last === undefined) return;
    afterId = last;
  }
}
