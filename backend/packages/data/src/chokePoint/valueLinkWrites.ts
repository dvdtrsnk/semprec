// Owns how writes change the state of value links (issue #1516): a user or agent write that changes
// a linked value ends the link, and the `valueLinks` process may write a user-owned property only
// while its link is `on`. The state change runs in the writer's own transaction, so it commits or
// rolls back with the value change. Creating links and the explicit unlink/relink operations are
// not here.
// Constrained by: docs/adr/2026-09-10-single-writer-ownership-model.md,
// docs/adr/2026-09-10-choke-point-api-for-state-writes.md
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
 * Ends the `on` links of the given properties when the writer is a user or an agent. A system
 * writer, a missing row and an already broken row change nothing. Returns the ids of the items
 * whose link state changed (the item itself, or none).
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

/**
 * Ends the links on both sides of a relation edge that was actually added or removed: item A with
 * the key of the definition's side A property, item B with the key of side B when the definition
 * has one. Call it only when the edge changed, never for a metadata replacement. Announces every
 * item whose state changed once the transaction commits, so clients refetch `links`. Also the
 * entry point the single-valued replace operation (#1521) calls.
 */
export async function breakValueLinksForRelationEdge(
  client: PoolClient,
  input: { reldef: RelationDefinitionRow; itemA: string; itemB: string; writerKind: WriterKind; actingUserId?: string },
): Promise<string[]> {
  if (input.writerKind === "system") return [];
  const sides = [{ propertyId: input.reldef.propertyIdA, itemId: input.itemA }];
  if (input.reldef.propertyIdB) sides.push({ propertyId: input.reldef.propertyIdB, itemId: input.itemB });
  const announced = new Map<string, { itemId: string; databaseId: string; updatedAt: string }>();
  for (const side of sides) {
    const property = await propertiesStore.getProperty(client, side.propertyId);
    if (!property) continue;
    const changed = await breakValueLinks(client, {
      itemId: side.itemId,
      propertyKeys: [property.key],
      writerKind: input.writerKind,
    });
    for (const itemId of changed) {
      const item = await itemsStore.getItemById(client, property.databaseId, itemId);
      if (item) {
        const key = JSON.stringify([property.databaseId, itemId]);
        announced.set(key, { itemId, databaseId: property.databaseId, updatedAt: item.updatedAt });
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
