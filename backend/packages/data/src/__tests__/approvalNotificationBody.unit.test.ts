import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ApprovalRequest } from "../mcp/approvalRequestsStore.js";
import { approvalNotificationBody } from "../notifications/approvalNotificationBody.js";

const paramsByKey: Record<string, string[]> = {
  "approval.itemDelete": ["itemName", "databaseKey", "databaseName", "projectName", "linkedCount", "restorableDays"],
  "approval.itemDeleteImpact": [
    "itemName",
    "databaseKey",
    "databaseName",
    "projectName",
    "linkedCount",
    "restorableDays",
    "seriesInstanceCount",
    "attachmentCount",
    "hostEventCount",
  ],
  "approval.itemPatch": ["itemName", "databaseKey", "databaseName"],
  "approval.changesSeries": ["taskName", "fromRule", "toRule"],
  "approval.breaksLink": [
    "itemName",
    "databaseKey",
    "propertyName",
    "sourceItemName",
    "sourceDatabaseKey",
    "newValueName",
  ],
  "approval.relationPut": ["fromItemName", "fromDatabaseKey", "toItemName", "toDatabaseKey"],
  "approval.relationSet": ["fromItemName", "fromDatabaseKey", "propertyName"],
  "approval.propertyDelete": ["propertyName", "databaseKey", "databaseName", "affectedCount"],
  "approval.databaseArchive": ["databaseName", "affectedCount"],
  "approval.viewDelete": ["viewName", "databaseName"],
  "approval.relationDelete": ["fromItemName", "fromDatabaseKey", "toItemName", "toDatabaseKey"],
  "approval.pageRestore": ["itemName", "databaseKey", "databaseName"],
  "approval.pageReplace": ["itemName", "databaseKey", "databaseName"],
  "approval.pageConvertToBlock.text": ["pageName", "pageCount"],
  "approval.pageConvertToBlock.h1": ["pageName", "pageCount"],
  "approval.pageConvertToBlock.h2": ["pageName", "pageCount"],
  "approval.pageConvertToBlock.h3": ["pageName", "pageCount"],
  "approval.pageConvertToBlock.bullet": ["pageName", "pageCount"],
  "approval.pageConvertToBlock.number": ["pageName", "pageCount"],
  "approval.pageConvertToBlock.todo": ["pageName", "pageCount"],
  "approval.pageConvertToBlock.quote": ["pageName", "pageCount"],
  "approval.journalMerge.year": ["period", "survivorName", "mergedName"],
  "approval.journalMerge.quarter": ["period", "survivorName", "mergedName"],
  "approval.journalMerge.month": ["period", "survivorName", "mergedName"],
  "approval.journalMerge.week": ["period", "survivorName", "mergedName"],
  "approval.journalMerge.day": ["period", "survivorName", "mergedName"],
  "approval.mcpInvoke": ["serverName", "toolName"],
  "approval.moduleTool": ["toolName"],
  "approval.emailSend": ["mailboxName", "recipientCount"],
};
const catalog = (locale: string) =>
  z
    .record(z.string(), z.string())
    .parse(JSON.parse(readFileSync(new URL(`../notifications/i18n/${locale}.json`, import.meta.url), "utf8")));
const mcp: Pick<ApprovalRequest, "description" | "payload" | "riskClass"> = {
  description: { key: "approval.mcpInvoke", params: { serverName: "server", toolName: "tool" } },
  payload: { mcpToolRegistrationId: "registration", mcpServerItemId: "server", args: { secret: "hidden" } },
  riskClass: "write",
};

describe("approval notification body", () => {
  it("provides all exact action templates and their declared parameters in both locales", () => {
    for (const locale of ["en", "cs"]) {
      const entries = catalog(locale);
      for (const [key, params] of Object.entries(paramsByKey)) {
        expect(entries[key]).toBeDefined();
        const names = [...entries[key]!.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
        expect(names).toEqual([...params].sort());
      }
    }
  });
  it("keeps separate localized app-undo sentences", () => {
    expect(catalog("en")["notification.body.canUndo"]).toBe("This can be undone later.");
    expect(catalog("en")["notification.body.cannotUndo"]).toBe("Semp cannot undo this action.");
    expect(catalog("cs")["notification.body.canUndo"]).toBe("Lze ji později vzít zpět.");
    expect(catalog("cs")["notification.body.cannotUndo"]).toBe("Semp tuto akci nedokáže vrátit zpět.");
  });
  it.each(["write", "outbound", "breaksLink", "destructive"] as const)(
    "does not promise app undo for MCP risk %s",
    (riskClass) => {
      const body = approvalNotificationBody({ ...mcp, riskClass });
      expect(body).toEqual({
        bodyKey: "approval.mcpInvoke",
        bodyParams: mcp.description!.params,
        bodySuffixKey: "notification.body.cannotUndo",
      });
      expect(JSON.stringify(body)).not.toContain("hidden");
    },
  );
  it("renders a module tool request from its tool name only and promises no app undo", () => {
    const body = approvalNotificationBody({
      riskClass: "write",
      description: { key: "approval.moduleTool", params: { toolName: "gated.apply" } },
      payload: { moduleToolName: "gated.apply", args: { secret: "private value" } },
    });
    expect(body).toEqual({
      bodyKey: "approval.moduleTool",
      bodyParams: { toolName: "gated.apply" },
      bodySuffixKey: "notification.body.cannotUndo",
    });
    expect(JSON.stringify(body)).not.toContain("private value");
  });
  it("renders a mail send request from the mailbox name and the recipient count only and promises no app undo", () => {
    const body = approvalNotificationBody({
      riskClass: "outbound",
      description: { key: "approval.emailSend", params: { mailboxName: "Personal", recipientCount: 3 } },
      payload: {
        draftId: "draft",
        draftHash: "hash",
        mailboxId: "mailbox",
        to: [{ name: "Private Name", address: "private@example.test" }],
        subject: "Private subject",
        body: "Private text",
      },
    });
    expect(body).toEqual({
      bodyKey: "approval.emailSend",
      bodyParams: { mailboxName: "Personal", recipientCount: 3 },
      bodySuffixKey: "notification.body.cannotUndo",
    });
    expect(JSON.stringify(body)).not.toContain("Private");
  });
  it.each([
    ["item.delete", "notification.body.canUndo"],
    ["property.delete", "notification.body.cannotUndo"],
  ] as const)("selects undo capability for %s", (operationName, bodySuffixKey) => {
    expect(
      approvalNotificationBody({
        ...mcp,
        description: { key: "approval.itemDelete", params: {} },
        payload: {
          operationName,
          canonicalInput: {},
          actor: { runId: "run", agentProjectItemId: "project", userId: "user" },
          resourceSnapshot: { kind: "test", resourceId: "id", sha256: null },
        },
      }).bodySuffixKey,
    ).toBe(bodySuffixKey);
  });
  it("selects the delete body that names the impact only for a description that carries its three counts", () => {
    const base = {
      itemName: "Review",
      databaseKey: "tasks",
      databaseName: "Tasks",
      linkedCount: 1,
      restorableDays: 30,
    };
    const impact = { seriesInstanceCount: 3, attachmentCount: 2, hostEventCount: 1 };
    const body = (params: Record<string, string | number>) =>
      approvalNotificationBody({ ...mcp, description: { key: "approval.itemDelete", params } }).bodyKey;

    expect(body({ ...base, ...impact })).toBe("approval.itemDeleteImpact");
    expect(body(base)).toBe("approval.itemDelete");
    expect(body({ ...base, seriesInstanceCount: 3 })).toBe("approval.itemDelete");
  });
  it("omits absent descriptions and refuses unknown templates", () => {
    expect(approvalNotificationBody({ ...mcp, description: null })).toEqual({});
    expect(() => approvalNotificationBody({ ...mcp, description: { key: "approval.unknown", params: {} } })).toThrow(
      /no body entry/,
    );
  });
  it("uses the recurrence description and its exact parameters", () => {
    const params = { taskName: "Task", fromRule: "daily", toRule: "weekly" };
    expect(approvalNotificationBody({ ...mcp, description: { key: "approval.changesSeries", params } })).toEqual({
      bodyKey: "approval.changesSeries",
      bodyParams: params,
      bodySuffixKey: "notification.body.cannotUndo",
    });
  });
  it.each([
    ["item.patch", "approval.itemPatch"],
    ["relation.put", "approval.relationPut"],
    ["relation.set", "approval.relationSet"],
  ] as const)("renders %s from the safe snapshot without arguments", (operationName, key) => {
    const body = approvalNotificationBody({
      riskClass: "write",
      description: { key, params: { itemName: "Visible name" } },
      payload: {
        operationName,
        canonicalInput: { secret: "private value" },
        actor: { runId: "run", agentProjectItemId: "project", userId: "user" },
        resourceSnapshot: { kind: "test", resourceId: "id", sha256: null },
      },
    });
    expect(body).toEqual({
      bodyKey: key,
      bodyParams: { itemName: "Visible name" },
      bodySuffixKey: "notification.body.canUndo",
    });
    expect(JSON.stringify(body)).not.toContain("private value");
  });
  it("renders a Journal merge from the period and the two titles only, and promises no app undo (issue #2017)", () => {
    const params = {
      periodType: "day",
      period: "2026-10-16",
      survivorName: "Entry first",
      mergedName: "Entry second",
    };
    const body = approvalNotificationBody({
      riskClass: "destructive",
      description: { key: "approval.journalMerge", params },
      payload: {
        operationName: "page.mergeJournalDuplicates",
        canonicalInput: { type: "day", period: "2026-10-16", secret: "private value" },
        actor: { runId: "run", agentProjectItemId: "project", userId: "user" },
        resourceSnapshot: { kind: "journal_merge", resourceId: "day:2026-10-16", sha256: null },
      },
    });
    expect(body).toEqual({
      bodyKey: "approval.journalMerge.day",
      bodyParams: params,
      bodySuffixKey: "notification.body.cannotUndo",
    });
    expect(JSON.stringify(body)).not.toContain("private value");
  });
  it.each([
    ["year", "2026", { en: "for the year 2026", cs: "za rok 2026" }],
    ["quarter", "2026-Q4", { en: "for the quarter 2026-Q4", cs: "za čtvrtletí 2026-Q4" }],
    ["month", "2026-10", { en: "for the month 2026-10", cs: "za měsíc 2026-10" }],
    ["week", "2026-W42", { en: "for the week 2026-W42", cs: "za týden 2026-W42" }],
    ["day", "2026-10-16", { en: "for the day 2026-10-16", cs: "za den 2026-10-16" }],
  ] as const)(
    "names a %s Journal merge with a localised period word and never the canonical type key (issue #2017)",
    (periodType, period, words) => {
      const { bodyKey, bodyParams } = approvalNotificationBody({
        ...mcp,
        riskClass: "destructive",
        description: {
          key: "approval.journalMerge",
          params: { periodType, period, survivorName: "First", mergedName: "Second" },
        },
      });
      expect(bodyKey).toBe(`approval.journalMerge.${periodType}`);
      // The stored params stay canonical; only the catalog entry turns the type into a word.
      expect(bodyParams).toMatchObject({ periodType, period });
      for (const locale of ["en", "cs"] as const) {
        const rendered = catalog(locale)[bodyKey!]!.replace(/\{(\w+)\}/g, (_, name: string) =>
          String(bodyParams![name]),
        );
        expect(rendered).toContain(words[locale]);
        // The English word is the type key only by coincidence; the Czech sentence must not carry it.
        if (locale === "cs") expect(rendered).not.toContain(`${periodType} ${period}`);
      }
    },
  );
  it("refuses a Journal merge description whose period type is not canonical", () => {
    expect(() =>
      approvalNotificationBody({
        ...mcp,
        description: { key: "approval.journalMerge", params: { periodType: "decade", period: "2020" } },
      }),
    ).toThrow(/unknown Journal period type/);
  });
  it.each([
    ["text", { en: "into a text block", cs: "na textový blok" }],
    ["h1", { en: "into a heading 1", cs: "na nadpis 1. úrovně" }],
    ["h2", { en: "into a heading 2", cs: "na nadpis 2. úrovně" }],
    ["h3", { en: "into a heading 3", cs: "na nadpis 3. úrovně" }],
    ["bullet", { en: "into a bulleted list item", cs: "na položku odrážkového seznamu" }],
    ["number", { en: "into a numbered list item", cs: "na položku číslovaného seznamu" }],
    ["todo", { en: "into a to-do", cs: "na úkol" }],
    ["quote", { en: "into a quote", cs: "na citaci" }],
  ] as const)(
    "names the %s block a page is converted into with a localised phrase and never the canonical type key (issue #1876)",
    (blockType, words) => {
      const params = { pageName: "Release checklist", blockType, pageCount: 3 };
      const body = approvalNotificationBody({
        riskClass: "destructive",
        description: { key: "approval.pageConvertToBlock", params },
        payload: {
          operationName: "page.convertToBlock",
          canonicalInput: { parentItemId: "parent", blockId: "block", type: blockType, secret: "private value" },
          actor: { runId: "run", agentProjectItemId: "project", userId: "user" },
          resourceSnapshot: { kind: "page_convert", resourceId: "page", sha256: null },
        },
      });
      expect(body).toEqual({
        bodyKey: `approval.pageConvertToBlock.${blockType}`,
        bodyParams: params,
        bodySuffixKey: "notification.body.canUndo",
      });
      expect(JSON.stringify(body)).not.toContain("private value");
      for (const locale of ["en", "cs"] as const) {
        const rendered = catalog(locale)[body.bodyKey!]!.replace(/\{(\w+)\}/g, (_, name: string) =>
          String(body.bodyParams![name]),
        );
        expect(rendered).toContain(words[locale]);
        expect(rendered).toContain("Release checklist");
        expect(rendered).toContain("3");
      }
    },
  );
  it("refuses a page conversion description whose block type is not one the operation accepts", () => {
    for (const blockType of ["page", "heading", null]) {
      expect(() =>
        approvalNotificationBody({
          ...mcp,
          description: { key: "approval.pageConvertToBlock", params: { pageName: "x", blockType, pageCount: 1 } },
        }),
      ).toThrow(/unknown block type/);
    }
  });
});
