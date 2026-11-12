// Describes the value links an approval-gated write would end (issue #1758): the `breaksLinks` and
// `endsInheritance` lists of the request view and the `approval.breaksLink` description, read in the
// same transaction as the request insert. The description names the write that really runs (setting
// one property of one item to a value, or for a relation property writing that relation) and the
// link that ends with it; it is never a generic "change the item".
//
// Template and params (the catalogs are `seed/i18n/{cs,en}.json` and `notifications/i18n/{cs,en}.json`):
//   approval.breaksLink   {itemName, databaseKey, propertyName, sourceItemName, sourceDatabaseKey, newValueName}
// The params describe the first link; `breaksLinks` lists every link, one entry per link and source.
// Constrained by: docs/adr/2026-09-18-exactly-once-execution-of-approved-destructive-operations.md
import type { PoolClient } from "pg";
import * as databasesStore from "../chokePoint/databasesStore.js";
import type { DestructiveOperationCheck } from "../chokePoint/destructiveProjection.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import type { BreakingLink, BreakingValueLinks } from "../chokePoint/valueLinkApproval.js";
import { listOnValueLinksFollowing } from "../chokePoint/valueLinksStore.js";
import type { ApprovalDescription, BreaksLinkEntry, EndsInheritanceEntry } from "./approvalRequestsStore.js";

/** Longest value name a description carries, in characters. */
const VALUE_NAME_MAX_LENGTH = 200;

type ItemRow = Awaited<ReturnType<typeof itemsStore.getItemsByIds>>[number];

export interface BreaksLinkApproval {
  description: ApprovalDescription;
  breaksLinks: BreaksLinkEntry[];
  endsInheritance: EndsInheritanceEntry[];
}

/** The operations whose request is a `breaksLink` request; `relation.delete` keeps its own description and risk class. */
export function isLinkDeferralOperation(operation: DestructiveOperationCheck["operation"]): boolean {
  return (
    operation === "item.patch" ||
    operation === "relation.put" ||
    operation === "relation.set" ||
    operation === "link.unlink"
  );
}

function displayValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let text: string;
  if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean") text = String(value);
  else if (Array.isArray(value)) text = value.flatMap((entry) => displayValue(entry) ?? []).join(", ");
  else text = JSON.stringify(value);
  return text.slice(0, VALUE_NAME_MAX_LENGTH);
}

async function itemName(client: PoolClient, item: ItemRow | undefined): Promise<string | null> {
  if (!item) return null;
  const [label] = await databasesStore.listDatabaseLabelsByIds(client, [item.databaseId]);
  const title = label?.titlePropertyKey ? item.properties[label.titlePropertyKey] : undefined;
  if (typeof title === "string") return title;
  return typeof item.properties.name === "string" ? item.properties.name : null;
}

async function databaseKeyOf(client: PoolClient, item: ItemRow | undefined): Promise<string | null> {
  return item ? ((await databasesStore.getDatabase(client, item.databaseId))?.key ?? null) : null;
}

/** The name of the value the write sets on `link`'s property; `null` where the write sets none. */
async function newValueNameOf(
  client: PoolClient,
  check: DestructiveOperationCheck,
  link: BreakingLink,
  items: Map<string, ItemRow>,
): Promise<string | null> {
  switch (check.operation) {
    case "item.patch":
      return displayValue(check.input.properties?.[link.propertyKey]);
    case "relation.put":
    case "relation.set": {
      const caller = check.input.callerItemId.toLowerCase();
      const otherId = link.itemId === caller ? check.input.targetItemId?.toLowerCase() : caller;
      return otherId ? itemName(client, items.get(otherId)) : null;
    }
    case "link.unlink": {
      // An unlink keeps the value the property holds; the property is "set" to what it already is.
      const item = items.get(link.itemId);
      if (!item) return null;
      const property = await propertiesStore.getPropertyByKey(client, item.databaseId, link.propertyKey);
      if (property?.type !== "relation") return displayValue(item.properties[link.propertyKey]);
      const definition = await relationsStore.getRelationDefinitionByPropertyId(client, property.id);
      if (!definition) return null;
      const relatedIds = (await relationsStore.listRelationsForItem(client, definition.id, item.id)).map((edge) =>
        relationsStore.otherSide(edge, item.id),
      );
      const names = (await itemsStore.getItemsByIds(client, relatedIds)).map((related) => itemName(client, related));
      return displayValue(await Promise.all(names));
    }
    default:
      return null;
  }
}

/** The item whose property the write is aimed at; the first description is about its link. */
function primaryItemId(check: DestructiveOperationCheck): string | null {
  switch (check.operation) {
    case "item.patch":
    case "link.unlink":
      return check.input.itemId;
    case "relation.put":
    case "relation.set":
    case "relation.delete":
      return check.input.callerItemId.toLowerCase();
    default:
      return null;
  }
}

/**
 * The lists and, for the operations in `isLinkDeferralOperation`, the description of a request that ends
 * `valueLinks`. Link entries come in the order of the links, the primary item's first.
 */
export async function describeBreakingLinks(
  client: PoolClient,
  check: DestructiveOperationCheck,
  valueLinks: BreakingValueLinks,
): Promise<BreaksLinkApproval> {
  const primary = primaryItemId(check);
  const links = [...valueLinks.links].sort(
    (a, b) => Number(b.itemId === primary) - Number(a.itemId === primary) || a.id.localeCompare(b.id),
  );
  const relationInput = check.operation === "relation.put" || check.operation === "relation.set" ? check.input : null;
  const related = relationInput
    ? [relationInput.callerItemId, relationInput.targetItemId].flatMap((id) => (id ? [id.toLowerCase()] : []))
    : [];
  const sourceIds = links.flatMap((link) => link.sources.flatMap((s) => (s.kind === "item" ? [s.sourceItemId] : [])));
  const items = new Map(
    (
      await itemsStore.getItemsByIds(client, [...new Set([...links.map((l) => l.itemId), ...related, ...sourceIds])])
    ).map((item) => [item.id, item]),
  );
  const breaksLinks: BreaksLinkEntry[] = [];
  const endsInheritance: EndsInheritanceEntry[] = [];
  const params: ApprovalDescription["params"][] = [];
  for (const link of links) {
    const item = items.get(link.itemId);
    const name = await itemName(client, item);
    const newValueName = await newValueNameOf(client, check, link, items);
    const sources = link.sources.length > 0 ? link.sources : [null];
    for (const source of sources) {
      const sourceItem = source?.kind === "item" ? items.get(source.sourceItemId) : undefined;
      const entry: BreaksLinkEntry = {
        itemId: link.itemId,
        itemName: name,
        propertyKey: link.propertyKey,
        sourceItemId: source?.kind === "item" ? source.sourceItemId : null,
        sourceItemName: source?.kind === "senderDomain" ? source.domain : await itemName(client, sourceItem),
        sourceDatabaseKey: await databaseKeyOf(client, sourceItem),
        newValueName,
      };
      breaksLinks.push(entry);
      if (params.length === 0 && item) {
        const property = await propertiesStore.getPropertyByKey(client, item.databaseId, link.propertyKey);
        params.push({
          itemName: name,
          databaseKey: await databaseKeyOf(client, item),
          propertyName: property?.name ?? link.propertyKey,
          sourceItemName: entry.sourceItemName,
          sourceDatabaseKey: entry.sourceDatabaseKey,
          newValueName,
        });
      }
    }
    for (const follower of await listOnValueLinksFollowing(client, link.itemId, link.propertyKey)) {
      endsInheritance.push({ itemId: follower.itemId, propertyKey: follower.propertyKey, sourceName: name });
    }
  }
  return {
    description: { key: "approval.breaksLink", params: params[0] ?? {} },
    breaksLinks,
    endsInheritance,
  };
}
