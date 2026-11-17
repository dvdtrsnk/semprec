// How writes change value-link state: a user or agent write that changes a linked value ends the
// link, and the `valueLinks` process may write a user-owned property only while its link is `on`.
// The state change runs in the writer's transaction so it commits or rolls back with the value.
import type { PoolClient } from "pg";
import { runAfterCommit } from "../db/pool.js";
import { ForbiddenError } from "../errors.js";
import { notifyInvalidation } from "../realtimeHook.js";
import type { RelationDefinitionRow } from "../types.js";
import * as itemsStore from "./itemsStore.js";
import * as propertiesStore from "./propertiesStore.js";
import { breakOnValueLinks, lockOnValueLink } from "./valueLinksStore.js";
import type { WriterKind } from "./writerKind.js";

/** The system process that writes inherited values; the declared handoff target for user-owned properties. */
export const VALUE_LINKS_OWNER_PROCESS = "valueLinks";

export interface BreakValueLinksInput {
  itemId: string;
  propertyKeys: string[];
  writerKind: WriterKind;
}

/**
 * Ends the `on` links of the given properties when the writer is a user or an agent. A system writer,
 * a missing row and an already broken row change nothing. Returns the ids of items whose state changed.
 */
export async function breakValueLinks(client: PoolClient, input: BreakValueLinksInput): Promise<string[]> {
  if (input.writerKind === "system") return [];
  const changed = await breakOnValueLinks(client, {
    itemId: input.itemId,
    propertyKeys: input.propertyKeys,
    brokenBy: input.writerKind,
  });
  return changed.length > 0 ? [input.itemId] : [];
}

/** Rejects a `valueLinks` write to a user-owned property that has no `on` link row for this item. */
export async function assertValueLinkHandoff(
  client: PoolClient,
  input: { itemId: string; propertyKey: string; lockMode?: "nowait" | "none" },
): Promise<void> {
  if (await lockOnValueLink(client, input.itemId, input.propertyKey, input.lockMode)) return;
  throw new ForbiddenError(
    `Property '${input.propertyKey}' is user-owned and has no active value link on this item`,
    { field: input.propertyKey },
    "owner_violation",
  );
}

/** One side of a relation edge, as the property of an item that a value link can be on. */
export interface RelationEdgeLinkTarget {
  itemId: string;
  propertyKey: string;
  databaseId: string;
}

/** Item A with side A's property key, and item B with side B's when the definition has one. */
export async function relationEdgeLinkTargets(
  client: PoolClient,
  input: { reldef: RelationDefinitionRow; itemA: string; itemB: string },
): Promise<RelationEdgeLinkTarget[]> {
  const sides = [{ propertyId: input.reldef.propertyIdA, itemId: input.itemA }];
  if (input.reldef.propertyIdB) sides.push({ propertyId: input.reldef.propertyIdB, itemId: input.itemB });
  const targets: RelationEdgeLinkTarget[] = [];
  for (const side of sides) {
    const property = await propertiesStore.getProperty(client, side.propertyId);
    if (property) targets.push({ itemId: side.itemId, propertyKey: property.key, databaseId: property.databaseId });
  }
  return targets;
}

/**
 * Ends the links on both sides of an edge that was actually added or removed; never call it for a
 * metadata replacement. Announces every changed item after commit so clients refetch `links`.
 */
export async function breakValueLinksForRelationEdge(
  client: PoolClient,
  input: { reldef: RelationDefinitionRow; itemA: string; itemB: string; writerKind: WriterKind; actingUserId?: string },
): Promise<string[]> {
  if (input.writerKind === "system") return [];
  const announced = new Map<string, { itemId: string; databaseId: string; updatedAt: string }>();
  for (const side of await relationEdgeLinkTargets(client, input)) {
    const changed = await breakValueLinks(client, {
      itemId: side.itemId,
      propertyKeys: [side.propertyKey],
      writerKind: input.writerKind,
    });
    for (const itemId of changed) {
      const item = await itemsStore.getItemById(client, side.databaseId, itemId);
      if (item) {
        const key = JSON.stringify([side.databaseId, itemId]);
        announced.set(key, { itemId, databaseId: side.databaseId, updatedAt: item.updatedAt });
      }
    }
  }
  if (announced.size > 0) {
    runAfterCommit(client, () => {
      for (const { itemId, databaseId, updatedAt } of announced.values()) {
        notifyInvalidation({ scope: "item", databaseId, itemId, op: "update", updatedAt, userId: input.actingUserId });
      }
    });
  }
  return [...announced.values()].map((entry) => entry.itemId);
}
