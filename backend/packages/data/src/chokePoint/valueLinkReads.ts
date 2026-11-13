// Owns the batched read behind `include=links` (issue #1403): the value links of a set of items,
// with their sources' titles and database keys resolved. It does not write links (that is
// link creation, #1593) and knows nothing about which transport asked.
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

/** An item's links keyed by property key. */
export type ItemValueLinks = Record<string, ValueLinkEntry>;

/**
 * Per item id, the links on it keyed by property key; an item with no link has no entry in the
 * map. A constant number of queries whatever the number of items or sources: links, sources, the
 * source items (a trashed or missing one is left out of `sources`, the entry still returned), and
 * their databases. Under the caller's tenant scope, so another tenant's rows and items are
 * invisible, a source id that belongs to another tenant included. A source item in one of
 * `unreadableDatabaseIds` (the databases the reading agent's project may not read, issue #1849) is left
 * out of `sources` like a missing one, so its id, database key and title are not returned. The derived
 * sources are projects, areas and companies, which are non-sensitive system databases that every project may read.
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
    const projectIds = [
      ...new Set(
        [...derived.values()].flatMap((value) => [
          ...(value.area?.projectIds ?? []),
          ...(value.company?.projectIds ?? []),
        ]),
      ),
    ];
    const projects = await itemsStore.getItemsByIds(client, projectIds);
    const labels = await databasesStore.listDatabaseLabelsByIds(client, [
      ...new Set(projects.map((p) => p.databaseId)),
    ]);
    const labelById = new Map(labels.map((label) => [label.id, label]));
    const projectById = new Map(projects.map((project) => [project.id, project]));
    for (const [itemId, values] of derived) {
      const itemLinks = result.get(itemId) ?? {};
      for (const key of ["area", "company"] as const) {
        const value = values[key];
        if (!value) continue;
        const sources: ValueLinkSource[] = value.projectIds.flatMap((id) => {
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
              propertyKey: key,
            },
          ];
        });
        Object.defineProperty(itemLinks, key, {
          value: { valueKind: "derived", sources, brokenBy: null, brokenAt: null },
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      result.set(itemId, itemLinks);
    }
  }
  return result;
}
