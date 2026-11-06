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
import { getValueLinksForItems, type ValueLinkEntry } from "./valueLinkReads.js";
import { updateItemWithClient } from "./itemWrites.js";
import { createRelationWithClient, deleteRelationWithClient } from "./relationOps.js";
import type { ChokePointDeps } from "./chokePointDeps.js";

export interface LinkInput {
  itemId: string;
  propertyKey: string;
}
type LinkOutput = LinkInput & ValueLinkEntry;

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
      next = (await relationsStore.listRelationsForItem(client, definition.id, item.id)).map((edge) =>
        relationsStore.otherSide(edge, item.id),
      );
    } else {
      const value = item.properties[property.key];
      next =
        value == null || value === "" ? [] : property.type === "multi_select" && Array.isArray(value) ? value : [value];
    }
    for (const value of next) if (!values.some((previous) => isDeepStrictEqual(previous, value))) values.push(value);
  }
  return { live, values };
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

export function createValueLinkOps({ pool }: Pick<ChokePointDeps, "pool">) {
  async function change(
    input: LinkInput,
    kind: "unlink" | "relink",
    writer: "user" | "agent",
    userId?: string,
  ): Promise<LinkOutput> {
    return withTransaction(pool, async (client) => {
      const [visible] = await itemsStore.getItemsByIds(client, [input.itemId]);
      if (!visible) throw new NotFoundError("Item not found", { resource: "item", itemId: input.itemId });
      const item = await itemsStore.lockItemById(client, visible.databaseId, input.itemId);
      if (!item || item.deletedAt)
        throw new NotFoundError("Item not found", { resource: "item", itemId: input.itemId });
      const link = await valueLinksStore.lockValueLink(client, item.id, input.propertyKey);
      if (!link) conflict();
      let changed: boolean;
      if (kind === "unlink") {
        changed =
          (await breakValueLinks(client, { itemId: item.id, propertyKeys: [input.propertyKey], writerKind: writer }))
            .length > 0;
      } else {
        const property = await propertiesStore.getPropertyByKey(client, item.databaseId, input.propertyKey);
        if (!property) conflict();
        const { live, values } = await sourceValues(client, link.id);
        if (live === 0) conflict();
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
    });
  }
  return {
    unlinkValue: (input: LinkInput, writer: "user" | "agent", userId?: string) =>
      change(input, "unlink", writer, userId),
    relinkValue: (input: LinkInput, userId?: string) => change(input, "relink", "user", userId),
  };
}
