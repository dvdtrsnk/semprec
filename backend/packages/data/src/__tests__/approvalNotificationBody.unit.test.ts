import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OPERATION_METADATA } from "@semprec/shared";
import { approvalNotificationBody } from "../notifications/approvalNotificationBody.js";

/** The parameters each description key carries, per the template contract in `mcp/approvalDescription.ts`. */
const DESCRIPTION_PARAMS: Record<string, readonly string[]> = {
  "approval.itemDelete": ["itemName", "databaseKey", "databaseName", "projectName", "linkedCount", "restorableDays"],
  "approval.propertyDelete": ["propertyName", "databaseKey", "databaseName", "affectedCount"],
  "approval.databaseArchive": ["databaseName", "affectedCount"],
  "approval.viewDelete": ["viewName", "databaseName"],
  "approval.relationDelete": ["fromItemName", "fromDatabaseKey", "toItemName", "toDatabaseKey"],
  "approval.pageRestore": ["itemName", "databaseKey", "databaseName"],
  "approval.mcpInvoke": ["serverName", "toolName"],
};

/** The description key and the generic operation it snapshots; MCP calls name no generic operation. */
const OPERATION_BY_DESCRIPTION_KEY: Record<string, keyof typeof OPERATION_METADATA | null> = {
  "approval.itemDelete": "item.delete",
  "approval.propertyDelete": "property.delete",
  "approval.databaseArchive": "database.archive",
  "approval.viewDelete": "view.delete",
  "approval.relationDelete": "relation.delete",
  "approval.pageRestore": "page.restoreVersion",
  "approval.mcpInvoke": null,
};

const UNDO_SENTENCE = { en: "This can be undone later.", cs: "Lze ji později vzít zpět." };
const IRREVERSIBLE_SENTENCE = { en: "This action is irreversible.", cs: "Tuto akci nelze vzít zpět." };

/** Reads a notifications catalog as a flat string map; anything that is not one is a broken catalog. */
function readCatalog(locale: "en" | "cs"): Record<string, string> {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL(`../notifications/i18n/${locale}.json`, import.meta.url), "utf8"),
  );
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${locale}.json is not a flat object`);
  }
  const catalog: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") throw new Error(`${locale}.json entry ${key} is not a string`);
    catalog[key] = value;
  }
  return catalog;
}

function placeholdersOf(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
}

const en = readCatalog("en");
const cs = readCatalog("cs");

describe("approvalNotificationBody (issue #1773)", () => {
  it("maps each approval description key to its body entry and passes the description params through", () => {
    for (const key of Object.keys(DESCRIPTION_PARAMS)) {
      const params = { itemName: "Tax return", databaseName: "Tasks", toolName: "search_web" };
      expect(approvalNotificationBody({ key, params })).toEqual({
        bodyKey: `notification.approval_pending.body.${key.slice("approval.".length)}`,
        bodyParams: params,
      });
    }
  });

  it("writes no body for a request without a description (a row written before issue #1683)", () => {
    expect(approvalNotificationBody(null)).toEqual({});
  });

  it("throws for a description key that has no body entry, so the request and its notification roll back together", () => {
    expect(() => approvalNotificationBody({ key: "approval.unknownThing", params: {} })).toThrow(
      /no body entry for approval description "approval.unknownThing"/,
    );
  });

  it("has a non-empty English and Czech entry for every body key, and the title in both locales", () => {
    for (const key of Object.keys(DESCRIPTION_PARAMS)) {
      const bodyKey = `notification.approval_pending.body.${key.slice("approval.".length)}`;
      expect(en[bodyKey]).toEqual(expect.any(String));
      expect(cs[bodyKey]).toEqual(expect.any(String));
      expect(en[bodyKey]).not.toBe("");
      expect(cs[bodyKey]).not.toBe("");
    }
    expect(en["notification.approval_pending.title"]).toBe("Semp needs approval");
    expect(cs["notification.approval_pending.title"]).toBe("Semp potřebuje schválení");
    expect(en["notification.body.unnamed"]).toBe("unnamed");
    expect(cs["notification.body.unnamed"]).toBe("bez názvu");
  });

  it("uses only description params in each body entry, with the same placeholders in both locales", () => {
    for (const [key, allowed] of Object.entries(DESCRIPTION_PARAMS)) {
      const bodyKey = `notification.approval_pending.body.${key.slice("approval.".length)}`;
      expect(placeholdersOf(en[bodyKey]!).every((name) => allowed.includes(name))).toBe(true);
      expect(placeholdersOf(cs[bodyKey]!)).toEqual(placeholdersOf(en[bodyKey]!));
    }
  });

  it("ends each body with the undo sentence exactly when the generic operation is flagged reversible (issue #1730)", () => {
    for (const [key, operation] of Object.entries(OPERATION_BY_DESCRIPTION_KEY)) {
      const bodyKey = `notification.approval_pending.body.${key.slice("approval.".length)}`;
      // An MCP call names no generic operation, and Semp has no undo for one, so it is irreversible.
      const reversible = operation === null ? false : OPERATION_METADATA[operation].reversible;
      expect(en[bodyKey]!.endsWith(reversible ? UNDO_SENTENCE.en : IRREVERSIBLE_SENTENCE.en)).toBe(true);
      expect(cs[bodyKey]!.endsWith(reversible ? UNDO_SENTENCE.cs : IRREVERSIBLE_SENTENCE.cs)).toBe(true);
    }
  });
});
