import type { Queryable } from "../db/pool.js";
import * as itemsStore from "../chokePoint/itemsStore.js";

export interface InboxTypeSummary {
  id: string;
  emoji: string;
  label: string;
}

/**
 * The data behind `GET /api/inbox-types` (issue #101; no HTTP layer exists yet in this repo
 * to mount it on — see backend/services' "empty until its issue" convention). Returns only
 * active types: archiving a type (issue #102) removes it from new capture while existing
 * Inbox items keep pointing at its id validly. `label` is the type's own `name`, not looked
 * up via i18n — unlike a structural, system-defined vocabulary entry, an Inbox item type is
 * user-managed content, the same as any other item's `name`. Relations always store `id`,
 * never `emoji` — renaming a type's emoji afterwards cannot break an Inbox item's relation.
 */
export async function listActiveInboxTypes(client: Queryable, inboxItemTypesDatabaseId: string): Promise<InboxTypeSummary[]> {
  const { items } = await itemsStore.listItems(client, inboxItemTypesDatabaseId, {
    limit: 200,
    buildFilterSql: (params) => {
      params.push("active");
      return `properties ->> 'status' = $${params.length}`;
    },
  });
  return items.map((item) => ({
    id: item.id,
    emoji: typeof item.properties.emoji === "string" ? item.properties.emoji : "",
    label: typeof item.properties.name === "string" ? item.properties.name : "",
  }));
}
