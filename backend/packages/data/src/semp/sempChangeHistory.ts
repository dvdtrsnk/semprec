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

/** Message history cards for the items a reply changed, resolved for a whole page of messages at once. */

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

function parseStoredChanges(stored: unknown): SempReplyChange[] {
  const entries = storedChangesSchema.safeParse(stored);
  if (!entries.success) return [];
  return entries.data.flatMap((entry) => {
    const parsed = storedChangeSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * Relation property keys per database. Links live in `item_relations`, never in `properties`, so a changed
 * relation key has no value to show.
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
 * The cards of each message of one history page, in `storedChanges` order; `undefined` for a message without a
 * readable entry, and malformed entries are left out.
 *
 * A fixed number of batched statements per page, however many cards; none for a page without entries.
 * An item in, or inheriting from, a sensitive database resolves with label, database key and state only and
 * carries no `before`. An item outside the tenant scope or the named database is purged and has no values.
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
