import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ApprovalRequest } from "../mcp/approvalRequestsStore.js";
import { approvalNotificationBody } from "../notifications/approvalNotificationBody.js";

const paramsByKey: Record<string, string[]> = {
  "approval.itemDelete": ["itemName", "databaseKey", "databaseName", "projectName", "linkedCount", "restorableDays"],
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
  "approval.mcpInvoke": ["serverName", "toolName"],
  "approval.moduleTool": ["toolName"],
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
});
