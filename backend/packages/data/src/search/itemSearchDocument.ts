import type { ModuleCatalogs, ModuleDatabaseDescriptor } from "@semprec/module-registry";
import { resolveProperty, type ManifestLocale } from "../manifest/catalogResolution.js";
import { normalizeSearchPhone } from "./phoneNormalization.js";
import { FILES_MODULE_ID, JOURNAL_MODULE_ID, PEOPLE_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { ItemRow, PropertyRow } from "../types.js";

export interface ItemSearchDocumentInput {
  item: Pick<ItemRow, "properties" | "computed">;
  databaseKey: string | null;
  descriptor?: ModuleDatabaseDescriptor;
  properties: PropertyRow[];
  relatedTitles: string[];
  /** The item's converted page text (`item_search_index.page_text`); null or absent when the item has no page text. */
  pageText?: string | null;
  locale: ManifestLocale;
  catalogs?: ModuleCatalogs;
}

/** The cached Inbox entry texts of a Journal day (issue #106); empty for every other item. */
function journalInboxTexts(input: Pick<ItemSearchDocumentInput, "item" | "databaseKey">): string[] {
  if (input.databaseKey !== JOURNAL_MODULE_ID || input.item.properties.type !== "day") return [];
  const entries: unknown = input.item.computed.inboxItems;
  if (!Array.isArray(entries)) return [];
  const texts: string[] = [];
  const summaries: unknown[] = entries;
  for (const entry of summaries) {
    if (typeof entry === "object" && entry !== null && "text" in entry && typeof entry.text === "string") {
      texts.push(entry.text);
    }
  }
  return texts;
}

/** Pure text projection; related titles have already been resolved from live, tenant-visible edges. */
export function buildItemSearchDocument(input: ItemSearchDocumentInput): string {
  const fields = input.descriptor?.searchFields;
  const parts: string[] = [];
  for (const property of input.properties) {
    if (fields !== undefined && !fields.includes(property.key)) continue;
    const value = input.item.properties[property.key];
    if (input.databaseKey === PEOPLE_MODULE_ID && property.key === "phones" && typeof value === "string") {
      parts.push(...value.split(/\r?\n/).map(normalizeSearchPhone));
      continue;
    }
    switch (property.type) {
      case "title":
        if (typeof value === "string") {
          parts.push(value);
          if (input.databaseKey === FILES_MODULE_ID && property.key === "name") {
            parts.push((value.match(/[\p{L}\p{N}]+/gu) ?? []).join(" "));
          }
        }
        break;
      case "text":
      case "longText":
      case "url":
        if (typeof value === "string") parts.push(value);
        break;
      case "select":
      case "multi_select": {
        const options = resolveProperty(property, input.databaseKey, input.catalogs, input.locale).options ?? [];
        const values: unknown[] = property.type === "multi_select" && Array.isArray(value) ? value : [value];
        for (const selected of values) {
          if (typeof selected !== "string") continue;
          parts.push(options.find((option) => option.key === selected)?.label ?? selected);
        }
        break;
      }
    }
  }
  parts.push(...input.relatedTitles);
  parts.push(...journalInboxTexts(input));
  if (input.pageText) parts.push(input.pageText);
  return parts.filter((part) => part.trim().length > 0).join(" ");
}

/**
 * Excerpt source for `item_search_index.body` (issue #1658): a Journal day's Inbox entry texts followed by its
 * page text, or the page text alone for every other item. Null when there is neither.
 */
export function buildItemSearchBody(
  input: Pick<ItemSearchDocumentInput, "item" | "databaseKey" | "pageText">,
): string | null {
  const parts = [...journalInboxTexts(input), input.pageText ?? ""].filter((part) => part.trim().length > 0);
  return parts.length > 0 ? parts.join(" ") : null;
}
