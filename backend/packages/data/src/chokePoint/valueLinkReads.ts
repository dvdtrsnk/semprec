// The batched read behind `include=links`: the value links of a set of items, with their sources'
// titles and database keys resolved.
import type { PoolClient } from "pg";
import * as databasesStore from "./databasesStore.js";
import * as itemsStore from "./itemsStore.js";
import * as valueLinksStore from "./valueLinksStore.js";
import { getDerivedValuesForItems, type DerivedValues } from "../derived/derivedValueReads.js";

export type ValueLinkSource =
  | { kind: "item"; itemId: string; databaseKey: string | null; title: string; propertyKey: string }
  | { kind: "senderDomain"; domain: string; propertyKey: string };

export interface ValueLinkEntry {
  valueKind: "inherited" | "inheritedBroken" | "derived";
  sources: ValueLinkSource[];
  brokenBy: "user" | "agent" | null;
  brokenAt: string | null;
}

export type ItemValueLinks = Record<string, ValueLinkEntry>;

/**
 * Per item id, its links keyed by property key; an item with no link has no entry. A constant number
 * of queries whatever the input size. Runs under the caller's tenant scope. A trashed or missing
 * source item, or one in `unreadableDatabaseIds`, is left out of `sources` (the entry is still
 * returned), so its id, key and title are not disclosed.
 */
export async function getValueLinksForItems(
  client: PoolClient,
  itemIds: string[],
  includeDerived = false,
  preloadedDerived?: ReadonlyMap<string, DerivedValues>,
  unreadableDatabaseIds: ReadonlySet<string> = new Set(),
): Promise<Map<string, ItemValueLinks>> {
  const links = await valueLinksStore.listValueLinksByItemIds(client, itemIds);
  const result = new Map<string, ItemValueLinks>();
  if (links.length === 0 && !includeDerived) return result;

  const sourceRows = await valueLinksStore.listValueLinkSourcesByLinkIds(
    client,
    links.map((link) => link.id),
  );
  const sourceItemIds = [
    ...new Set(sourceRows.flatMap((source) => (source.kind === "item" ? [source.sourceItemId] : []))),
  ];
  const sourceItems = new Map(
    (await itemsStore.getItemsByIds(client, sourceItemIds)).map((item) => [item.id, item] as const),
  );
  const databases = new Map(
    (
      await databasesStore.listDatabaseLabelsByIds(client, [
        ...new Set([...sourceItems.values()].map((item) => item.databaseId)),
      ])
    ).map((database) => [database.id, database] as const),
  );

  function resolveSource(row: valueLinksStore.ValueLinkSourceRow): ValueLinkSource | null {
    if (row.kind === "senderDomain") {
      return { kind: "senderDomain", domain: row.domain, propertyKey: row.sourcePropertyKey };
    }
    const item = sourceItems.get(row.sourceItemId);
    if (!item || unreadableDatabaseIds.has(item.databaseId)) return null;
    const database = databases.get(item.databaseId);
    const titleValue = database?.titlePropertyKey ? item.properties[database.titlePropertyKey] : undefined;
    return {
      kind: "item",
      itemId: item.id,
      databaseKey: database?.ownerModuleId ?? null,
      title: typeof titleValue === "string" ? titleValue : "",
      propertyKey: row.sourcePropertyKey,
    };
  }

  const sourcesByLink = new Map<string, ValueLinkSource[]>();
  for (const row of sourceRows) {
    const source = resolveSource(row);
    if (!source) continue;
    const bucket = sourcesByLink.get(row.linkId);
    if (bucket) bucket.push(source);
    else sourcesByLink.set(row.linkId, [source]);
  }

  const entriesByItem = new Map<string, [string, ValueLinkEntry][]>();
  for (const link of links) {
    const entry: ValueLinkEntry = {
      valueKind: link.state === "broken" ? "inheritedBroken" : "inherited",
      sources: sourcesByLink.get(link.id) ?? [],
      brokenBy: link.brokenBy,
      brokenAt: link.brokenAt,
    };
    const bucket = entriesByItem.get(link.itemId);
    if (bucket) bucket.push([link.propertyKey, entry]);
    else entriesByItem.set(link.itemId, [[link.propertyKey, entry]]);
  }
  // `Object.fromEntries` defines own properties, so a property key such as `__proto__` stays data.
  for (const [itemId, entries] of entriesByItem) result.set(itemId, Object.fromEntries(entries));
  if (includeDerived) {
    const derived =
      preloadedDerived ?? (await getDerivedValuesForItems(client, await itemsStore.getItemsByIds(client, itemIds)));
    const projectIds = [...new Set([...derived.values()].flatMap((value) => value.company?.projectIds ?? []))];
    const projects = await itemsStore.getItemsByIds(client, projectIds);
    const labels = await databasesStore.listDatabaseLabelsByIds(client, [
      ...new Set(projects.map((p) => p.databaseId)),
    ]);
    const labelById = new Map(labels.map((label) => [label.id, label]));
    const projectById = new Map(projects.map((project) => [project.id, project]));
    for (const [itemId, { company }] of derived) {
      if (!company) continue;
      const itemLinks = result.get(itemId) ?? {};
      const sources: ValueLinkSource[] = company.projectIds.flatMap((id) => {
        const project = projectById.get(id);
        if (!project) return [];
        const label = labelById.get(project.databaseId);
        const title = project.properties[label?.titlePropertyKey ?? ""];
        return [
          {
            kind: "item",
            itemId: id,
            databaseKey: "projects",
            title: typeof title === "string" ? title : "",
            propertyKey: "company",
          },
        ];
      });
      Object.defineProperty(itemLinks, "company", {
        value: { valueKind: "derived", sources, brokenBy: null, brokenAt: null },
        enumerable: true,
        configurable: true,
        writable: true,
      });
      result.set(itemId, itemLinks);
    }
  }
  return result;
}
