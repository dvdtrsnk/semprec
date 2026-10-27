import { describe, expect, it } from "vitest";
import type { PropertyRow, PropertyType } from "../../types.js";
import { buildItemSearchDocument, type ItemSearchDocumentInput } from "../itemSearchDocument.js";

function property(key: string, type: PropertyType, config: Record<string, unknown> = {}): PropertyRow {
  return {
    id: key,
    databaseId: "db",
    key,
    name: null,
    type,
    config,
    locked: false,
    owner: "user",
    ownerProcess: null,
    migrationStatus: "stable",
  };
}
function input(overrides: Partial<ItemSearchDocumentInput> = {}): ItemSearchDocumentInput {
  return {
    item: { properties: {}, computed: {} },
    databaseKey: null,
    properties: [],
    relatedTitles: [],
    locale: "cs",
    ...overrides,
  };
}

describe("item search document", () => {
  it("defaults to every textual property and select label, excluding other values", () => {
    const properties = [
      property("title", "title"),
      property("text", "text"),
      property("long", "longText"),
      property("url", "url"),
      property("status", "select", { options: [{ key: "custom", label: "Custom label" }] }),
      property("tags", "multi_select", { options: [{ key: "first", label: "First label" }] }),
      property("count", "number"),
      property("json", "json"),
    ];
    expect(
      buildItemSearchDocument(
        input({
          properties,
          item: {
            properties: {
              title: "Title",
              text: "Text",
              long: "Long prose",
              url: "https://example.test",
              status: "custom",
              tags: ["first", "uncatalogued"],
              count: 42,
              json: { text: "Hidden" },
            },
            computed: {},
          },
        }),
      ),
    ).toBe("Title Text Long prose https://example.test Custom label First label uncatalogued");
  });

  it("uses declared fields, ignores unknown keys and still includes resolved related titles", () => {
    expect(
      buildItemSearchDocument(
        input({
          descriptor: { key: "db", name: "Database", searchFields: ["name", "missing", "link"] },
          properties: [property("name", "title"), property("excluded", "text"), property("link", "relation")],
          item: {
            properties: { name: "Item", missing: "Not a property", excluded: "Hidden", link: ["not edge titles"] },
            computed: {},
          },
          relatedTitles: ["Project", "Area", "Person", "Company"],
        }),
      ),
    ).toBe("Item Project Area Person Company");
  });

  it("distinguishes an explicit empty declaration from the default rule", () => {
    expect(
      buildItemSearchDocument(
        input({
          descriptor: { key: "db", name: "Database", searchFields: [] },
          properties: [property("name", "title")],
          item: { properties: { name: "Hidden" }, computed: {} },
        }),
      ),
    ).toBe("");
  });

  it.each(["cs", "en"] as const)("resolves shipped labels in %s and gives user overrides precedence", (locale) => {
    const catalogs = {
      cs: { "property.tasks.status.option.done": "Hotovo" },
      en: { "property.tasks.status.option.done": "Done", "property.tasks.status.option.fallback": "English fallback" },
    };
    const properties = [
      property("status", "multi_select", {
        options: [{ key: "done" }, { key: "fallback" }, { key: "override", label: "User label" }, { key: "unknown" }],
      }),
    ];
    expect(
      buildItemSearchDocument(
        input({
          databaseKey: "tasks",
          locale,
          catalogs,
          properties,
          item: { properties: { status: ["done", "fallback", "override", "unknown"] }, computed: {} },
        }),
      ),
    ).toBe(`${locale === "cs" ? "Hotovo" : "Done"} English fallback User label property.tasks.status.option.unknown`);
  });

  it("tolerates absent or malformed text, select, options and computed values", () => {
    expect(
      buildItemSearchDocument(
        input({
          properties: [
            property("text", "text"),
            property("status", "select", { options: [null, {}, { key: 4 }, { key: "bad", label: 2 }] }),
            property("multi", "multi_select"),
          ],
          item: {
            properties: { text: {}, status: "rawKey", multi: [null, 4, "retained"] },
            computed: { inboxItems: "bad" },
          },
        }),
      ),
    ).toBe("rawKey retained");
  });

  it("includes only string Inbox entry text for Journal days", () => {
    const journal = input({
      databaseKey: "journal",
      item: {
        properties: { type: "day" },
        computed: { inboxItems: [{ text: "Inbox note" }, { text: null }, {}, null, { text: 3 }] },
      },
    });
    expect(buildItemSearchDocument(journal)).toBe("Inbox note");
    expect(buildItemSearchDocument({ ...journal, databaseKey: "other" })).toBe("");
    expect(buildItemSearchDocument({ ...journal, item: { ...journal.item, properties: { type: "week" } } })).toBe("");
    expect(buildItemSearchDocument({ ...journal, item: { properties: { type: "day" }, computed: {} } })).toBe("");
    expect(
      buildItemSearchDocument({ ...journal, item: { properties: { type: "day" }, computed: { inboxItems: null } } }),
    ).toBe("");
  });
});
