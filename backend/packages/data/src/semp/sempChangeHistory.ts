import type { PoolClient } from "pg";
import { z } from "zod";
import type { SempThreadChange } from "@semprec/shared";
import { boundValue } from "../agentRuns/agentRunStepPages.js";
import { sensitiveSourceDatabaseIdsByItem } from "../agentGrants/inheritedSensitivity.js";
import { listDatabaseLabelsByIds } from "../chokePoint/databasesStore.js";
import { projectItemsForRead } from "../chokePoint/itemReadProjection.js";
import { getItemsByIdsIncludingDeleted } from "../chokePoint/itemsStore.js";
import type { SempReplyChange } from "./sempReplyChanges.js";
import { resolveSempItemRefs } from "./sempRefHistory.js";

/**
 * Message history cards for the items a reply changed (issue #1888): the entries stored by issue #1885 with the
 * current label, database key and state of each item, resolved for a whole page of messages at once.
 */

/** The stored shape of one entry (`SempReplyChange`), checked because the column is JSONB. */
const storedChangeSchema = z.object({
  itemId: z.uuid(),
  databaseId: z.uuid(),
  change: z.enum(["created", "updated", "deleted", "restored", "revised"]),
  changedKeys: z.array(z.string()),
  before: z.record(z.string(), z.unknown()).optional(),
  proposalId: z.string().optional(),
}) satisfies z.ZodType<SempReplyChange>;

const storedChangesSchema = z.array(z.unknown());

/** The entries of one stored column value that have the stored shape; a value that is not an array has none. */
function parseStoredChanges(stored: unknown): SempReplyChange[] {
  const entries = storedChangesSchema.safeParse(stored);
  if (!entries.success) return [];
  return entries.data.flatMap((entry) => {
    const parsed = storedChangeSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * The keys of the relation properties of each database. A relation is not a property value: the links live in
 * `item_relations`, and an item's `properties` never holds a relation key, so a changed relation key has no value to
 * show and is left out of `resolved.values`. One statement for all the databases of the page.
 */
async function relationKeysByDatabase(client: PoolClient, databaseIds: string[]): Promise<Map<string, Set<string>>> {
  const keys = new Map<string, Set<string>>();
  if (databaseIds.length === 0) return keys;
  const { rows } = await client.query<{ database_id: string; key: string }>(
    "SELECT database_id, key FROM properties WHERE database_id = ANY($1::uuid[]) AND type = 'relation'",
    [databaseIds],
  );
  for (const row of rows) {
    const set = keys.get(row.database_id) ?? new Set<string>();
    set.add(row.key);
    keys.set(row.database_id, set);
  }
  return keys;
}

/**
 * The cards of each message of one history page, in the order of `storedChanges` (the `changes` column of each
 * message); a message without a stored entry, whether its column is NULL, empty or unreadable, has `undefined`. An
 * entry that does not have the stored shape is left out.
 *
 * The page is resolved with a fixed number of batched statements, one per kind of lookup, however many cards it
 * holds: the items (the resolver of the reference history, `resolveSempItemRefs`, for label, database key and
 * state), their rows with the read projection, their databases and the sensitive databases they inherit from.
 * Nothing is queried for a page without entries.
 *
 * `resolved.values` is the current value of each changed key that holds a value; a changed relation key (a link made
 * or removed) is left out, since the links are not stored in the item's properties. An item in a sensitive database, or inheriting
 * sensitivity from one (issue #1999), resolves with label, database key and state only, and its card carries no
 * `before` either. An item the tenant scope does not show, or one that is not in the database the entry names, is
 * purged and has no values.
 */
export async function resolveSempHistoryChanges(
  client: PoolClient,
  storedChanges: readonly unknown[],
): Promise<(SempThreadChange[] | undefined)[]> {
  const perMessage = storedChanges.map(parseStoredChanges);
  const entries = perMessage.flat();
  if (entries.length === 0) return perMessage.map(() => undefined);

  const resolutions = await resolveSempItemRefs(
    client,
    entries.map((entry) => ({ itemId: entry.itemId, databaseId: entry.databaseId })),
  );
  const itemIds = [...new Set(entries.map((entry) => entry.itemId))];
  const items = new Map(
    (await projectItemsForRead(client, await getItemsByIdsIncludingDeleted(client, itemIds))).map((item) => [
      item.id,
      item,
    ]),
  );
  const sensitiveDatabaseIds = new Set(
    (await listDatabaseLabelsByIds(client, [...new Set([...items.values()].map((item) => item.databaseId))]))
      .filter((database) => database.sensitive)
      .map((database) => database.id),
  );
  const inheriting = await sensitiveSourceDatabaseIdsByItem(client, itemIds);
  const relationKeys = await relationKeysByDatabase(client, [
    ...new Set([...items.values()].map((item) => item.databaseId)),
  ]);

  const cards = entries.map((entry, index): SempThreadChange => {
    const resolved = resolutions[index];
    if (resolved === undefined) throw new Error("Invalid change resolution position");
    const itemId = entry.itemId.toLowerCase();
    const item = items.get(itemId);
    const sensitive = item !== undefined && (sensitiveDatabaseIds.has(item.databaseId) || inheriting.has(itemId));
    const values =
      item === undefined || resolved.state === "purged" || sensitive
        ? undefined
        : Object.fromEntries(
            entry.changedKeys
              .filter((key) => !relationKeys.get(item.databaseId)?.has(key))
              .map((key) => [key, Object.hasOwn(item.properties, key) ? boundValue(item.properties[key]) : null]),
          );
    const { before, ...stored } = entry;
    return {
      ...stored,
      ...(before === undefined || sensitive ? {} : { before }),
      resolved: { ...resolved, ...(values === undefined ? {} : { values }) },
    };
  });
  let offset = 0;
  return perMessage.map((messageEntries) => {
    const messageCards = cards.slice(offset, offset + messageEntries.length);
    offset += messageEntries.length;
    return messageCards.length === 0 ? undefined : messageCards;
  });
}
