import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { z } from "zod";
import { ChokePointError, NotFoundError } from "../errors.js";
import { runAfterCommit, withTransaction } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";
import * as itemsStore from "./itemsStore.js";
import * as propertiesStore from "./propertiesStore.js";
import * as relationsStore from "./relationsStore.js";
import * as valueLinksStore from "./valueLinksStore.js";
import { breakValueLinks, VALUE_LINKS_OWNER_PROCESS } from "./valueLinkWrites.js";
import { requireApprovalForUnlink } from "./valueLinkApproval.js";
import type { WriterIdentity } from "./writerKind.js";
import { getValueLinksForItems, type ValueLinkEntry } from "./valueLinkReads.js";
import { updateItemWithClient } from "./itemWrites.js";
import { createRelationWithClient, deleteRelationWithClient } from "./relationOps.js";
import type { ChokePointDeps } from "./chokePointDeps.js";
import { loadLinkRules, readOmittedItemIds, resolveValueFilter } from "../valueLinks/linkRuleCatalog.js";
import { withPropagationHop } from "../valueLinks/propagationContext.js";
import { assertWriterDatabaseAccess } from "../agentGrants/agentDatabaseAccess.js";

export interface LinkInput {
  itemId: string;
  propertyKey: string;
}
export type LinkOutput = LinkInput & ValueLinkEntry;

function conflict(): never {
  throw new ChokePointError(409, "value_link_conflict", "Value link cannot be changed");
}

async function sourceValues(client: PoolClient, linkId: string): Promise<{ live: number; values: unknown[] }> {
  const sources = await valueLinksStore.listValueLinkSourcesByLinkIds(client, [linkId]);
  const items = await itemsStore.getItemsByIds(
    client,
    sources.flatMap((source) => (source.kind === "item" ? [source.sourceItemId] : [])),
  );
  const byId = new Map(items.map((item) => [item.id, item]));
  const values: unknown[] = [];
  let live = 0;
  for (const source of sources) {
    if (source.kind !== "item") continue;
    const item = byId.get(source.sourceItemId);
    if (!item) continue;
    live++;
    const property = await propertiesStore.getPropertyByKey(client, item.databaseId, source.sourcePropertyKey);
    if (!property) continue;
    let next: unknown[];
    if (property.type === "relation") {
      const definition = await relationsStore.getRelationDefinitionByPropertyId(client, property.id);
      if (!definition) conflict();
      const related = (await relationsStore.listRelationsForItem(client, definition.id, item.id)).map((edge) =>
        relationsStore.otherSide(edge, item.id),
      );
      // The Trash keeps an item's edges. A related item in the Trash is not taken over, as in the propagation.
      const liveIds = new Set((await itemsStore.getItemsByIds(client, related)).map((entry) => entry.id));
      next = related.filter((id) => liveIds.has(id));
    } else {
      const value = item.properties[property.key];
      next =
        value == null || value === "" ? [] : property.type === "multi_select" && Array.isArray(value) ? value : [value];
    }
    for (const value of next) if (!values.some((previous) => isDeepStrictEqual(previous, value))) values.push(value);
  }
  return { live, values };
}

/**
 * The source values a relink takes over, without the items the `valueFilter` of the link's rule
 * leaves out (issue #1697), so a relink gives the same values as that rule's propagation. A link
 * whose rule is not loaded, or declares no filter, keeps every value. A filter that cannot be
 * resolved in the tenant's schema is a conflict: nothing is copied unfiltered.
 */
async function withoutOmittedValues(client: PoolClient, ruleKey: string, values: unknown[]): Promise<unknown[]> {
  const rule = (await loadLinkRules()).find((entry) => entry.key === ruleKey);
  if (!rule?.valueFilter) return values;
  const filter = await resolveValueFilter(client, rule.valueFilter.omit);
  if (!filter) conflict();
  const omitted: unknown[] = await readOmittedItemIds(client, filter);
  return values.filter((value) => !omitted.includes(value));
}

function announce(
  client: PoolClient,
  item: { id: string; databaseId: string; updatedAt: string },
  userId?: string,
): void {
  runAfterCommit(client, () =>
    notifyInvalidation({
      scope: "item",
      databaseId: item.databaseId,
      itemId: item.id,
      op: "update",
      updatedAt: item.updatedAt,
      userId,
    }),
  );
}

/** Who changes a link: a bare kind, or the full identity that tells an agent under a run from one without. */
export type ValueLinkWriter = "user" | "agent" | (WriterIdentity & { writerKind: "user" | "agent" });

/**
 * Unlinks or relinks within the caller's managed transaction. An unlink by an agent under a run that
 * would end an active link asks for approval first (issue #1758), which rolls the transaction back; the
 * approved replay (`approvedRequestId`) ends the link with `broken_by` agent. An unlink of a link that
 * is already broken stays the idempotent no-op it always was.
 *
 * An agent writer that carries a project (`agentProjectItemId`, issue #1810) needs `write` access to the
 * item's database, checked before anything about the link is read, so a refusal tells it nothing about the
 * link and a relink's own item and relation writes (which run as the value-links process) stay inside that grant.
 */
export async function changeValueLinkWithClient(
  client: PoolClient,
  input: LinkInput,
  kind: "unlink" | "relink",
  writer: ValueLinkWriter,
  userId?: string,
): Promise<LinkOutput> {
  const identity: WriterIdentity = typeof writer === "string" ? { writerKind: writer } : writer;
  const [visible] = await itemsStore.getItemsByIds(client, [input.itemId]);
  if (!visible) throw new NotFoundError("Item not found", { resource: "item", itemId: input.itemId });
  const item = await itemsStore.lockItemById(client, visible.databaseId, input.itemId);
  if (!item || item.deletedAt) throw new NotFoundError("Item not found", { resource: "item", itemId: input.itemId });
  await assertWriterDatabaseAccess(client, identity, item.databaseId, "write");
  const link = await valueLinksStore.lockValueLink(client, item.id, input.propertyKey);
  if (!link) conflict();
  let changed: boolean;
  if (kind === "unlink") {
    if (link.state === "on") requireApprovalForUnlink(client, identity, input);
    changed =
      (
        await breakValueLinks(client, {
          itemId: item.id,
          propertyKeys: [input.propertyKey],
          writerKind: identity.writerKind,
        })
      ).length > 0;
  } else {
    const property = await propertiesStore.getPropertyByKey(client, item.databaseId, input.propertyKey);
    if (!property) conflict();
    const { live, values: sourced } = await sourceValues(client, link.id);
    if (live === 0) conflict();
    const values = await withoutOmittedValues(client, link.ruleKey, sourced);
    if (property.type === "relation") {
      const definition = await relationsStore.getRelationDefinitionByPropertyId(client, property.id);
      if (!definition) conflict();
      const many =
        definition.cardinality === "many_to_many" ||
        (definition.cardinality === "one_to_many" && definition.propertyIdA === property.id);
      if (!many && values.length > 1) conflict();
      const parsed = z.array(z.uuid()).safeParse(values);
      if (!parsed.success) conflict();
      const desired = parsed.data;
      const current = (await relationsStore.listRelationsForItem(client, definition.id, item.id)).map((edge) =>
        relationsStore.otherSide(edge, item.id),
      );
      await valueLinksStore.reactivateValueLink(client, link.id);
      // Marked as `valueLinks` writes for the link rule hook, like a propagated value: an edge removed here
      // is a replaced inherited value, so a link that follows it through that edge moves with it. Hop 0 keeps
      // the budget of an ordinary root write.
      await withPropagationHop(client, 0, async () => {
        for (const id of current.filter((id) => !desired.includes(id)))
          await deleteRelationWithClient(
            client,
            { relationPropertyId: property.id, callerItemId: item.id, targetItemId: id },
            { ownerProcess: VALUE_LINKS_OWNER_PROCESS },
          );
        for (const id of desired.filter((id) => !current.includes(id)))
          await createRelationWithClient(
            client,
            { relationPropertyId: property.id, callerItemId: item.id, targetItemId: id },
            { ownerProcess: VALUE_LINKS_OWNER_PROCESS },
          );
      });
    } else {
      const many = property.type === "multi_select";
      if (!many && values.length > 1) conflict();
      await valueLinksStore.reactivateValueLink(client, link.id);
      await updateItemWithClient(
        client,
        {
          databaseId: item.databaseId,
          itemId: item.id,
          propertiesPatch: { [property.key]: many ? values : (values[0] ?? null) },
        },
        { systemOwnerProcess: VALUE_LINKS_OWNER_PROCESS },
      );
    }
    changed = true;
  }
  const entry = (await getValueLinksForItems(client, [item.id])).get(item.id)?.[input.propertyKey];
  if (!entry) conflict();
  if (changed) {
    const current = await itemsStore.getItemById(client, item.databaseId, item.id);
    if (!current) throw new Error("Reserved item disappeared during link update");
    announce(client, current, userId);
  }
  return { ...input, ...entry };
}

export function createValueLinkOps({ pool }: Pick<ChokePointDeps, "pool">) {
  return {
    unlinkValue: (input: LinkInput, writer: ValueLinkWriter, userId?: string) =>
      withTransaction(pool, (client) => changeValueLinkWithClient(client, input, "unlink", writer, userId)),
    relinkValue: (input: LinkInput, userId?: string, writer: ValueLinkWriter = "user") =>
      withTransaction(pool, (client) => changeValueLinkWithClient(client, input, "relink", writer, userId)),
  };
}
