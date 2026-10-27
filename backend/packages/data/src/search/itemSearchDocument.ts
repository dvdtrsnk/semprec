import type { ModuleCatalogs, ModuleDatabaseDescriptor } from "@semprec/module-registry";
import { resolveProperty, type ManifestLocale } from "../manifest/catalogResolution.js";
import { JOURNAL_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { ItemRow, PropertyRow } from "../types.js";

export interface ItemSearchDocumentInput {
  item: Pick<ItemRow, "properties" | "computed">;
  databaseKey: string | null;
  descriptor?: ModuleDatabaseDescriptor;
  properties: PropertyRow[];
  relatedTitles: string[];
  locale: ManifestLocale;
  catalogs?: ModuleCatalogs;
}

/** Pure text projection; related titles have already been resolved from live, tenant-visible edges. */
export function buildItemSearchDocument(input: ItemSearchDocumentInput): string {
  const fields = input.descriptor?.searchFields;
  const parts: string[] = [];
  for (const property of input.properties) {
    if (fields !== undefined && !fields.includes(property.key)) continue;
    const value = input.item.properties[property.key];
    switch (property.type) {
      case "title":
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
  if (input.databaseKey === JOURNAL_MODULE_ID && input.item.properties.type === "day") {
    const entries: unknown = input.item.computed.inboxItems;
    if (Array.isArray(entries)) {
      const summaries: unknown[] = entries;
      for (const entry of summaries) {
        if (typeof entry === "object" && entry !== null && "text" in entry && typeof entry.text === "string") {
          parts.push(entry.text);
        }
      }
    }
  }
  return parts.filter((part) => part.trim().length > 0).join(" ");
}
