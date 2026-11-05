import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { createLogger, currentTenantScope, TenantScopeMissingError } from "@semprec/shared";
import { withTransaction, runAfterCommit } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";
import { tenantLane } from "../tenancy/tenantLane.js";
import { getItemById, lockItemById } from "../chokePoint/itemsStore.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { createRelationWithClient, deleteRelationWithClient } from "../chokePoint/relationOps.js";
import { listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import {
  lockValueLink,
  pageValueLinksForSource,
  listValueLinkSourcesByLinkIds,
} from "../chokePoint/valueLinksStore.js";
import { VALUE_LINKS_OWNER_PROCESS } from "../chokePoint/valueLinkWrites.js";
import { loadLinkRules, resolveLinkRule, type ResolvedLinkRule } from "./linkRuleCatalog.js";
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

export function targetIsMany(resolved: ResolvedLinkRule): boolean {
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
  resolved: ResolvedLinkRule,
  itemId: string,
): Promise<unknown[]> {
  return readRuleValues(client, resolved.targetDatabase.id, itemId, resolved.targetProperty, resolved.targetDefinition);
}

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
  return distinct(values);
}

export async function applyInheritedValues(
  client: PoolClient,
  resolved: ResolvedLinkRule,
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
