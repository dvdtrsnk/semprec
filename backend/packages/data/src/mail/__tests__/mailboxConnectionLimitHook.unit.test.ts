import { describe, expect, it } from "vitest";
import type { DatabaseRow } from "../../types.js";
import { mailboxConnectionLimitCreateHook, mailboxConnectionLimitUpdateHook } from "../mailboxConnectionLimitHook.js";

function database(ownerModuleId: string | null): DatabaseRow {
  return {
    id: "db",
    key: null,
    name: "Database",
    parentItemId: null,
    ownerProjectItemId: null,
    ownerModuleId,
    schemaLocked: false,
    system: false,
    icon: null,
    color: null,
    overviewHidden: false,
    sensitive: false,
    archivedAt: null,
    purgeAt: null,
  };
}
const hooks = [
  {
    name: "create",
    run: (owner: string | null, properties: Record<string, unknown>) =>
      mailboxConnectionLimitCreateHook({ database: database(owner), properties }),
  },
  {
    name: "update",
    run: (owner: string | null, properties: Record<string, unknown>) =>
      mailboxConnectionLimitUpdateHook({ database: database(owner), propertiesPatch: properties }),
  },
];
for (const hook of hooks) {
  describe(`${hook.name} connection limit`, () => {
    it.each([0, 16, 2.5, "2", undefined, true, {}, NaN, Infinity, -1])(
      "refuses %s with the field and validation status",
      async (value) => {
        await expect(hook.run("mailboxes", { connectionLimit: value })).rejects.toMatchObject({
          status: 400,
          code: "validation_failed",
          details: { field: "connectionLimit" },
        });
      },
    );
    it.each([1, 15, 8, null])("accepts %s", async (value) => {
      await expect(hook.run("mailboxes", { connectionLimit: value })).resolves.toBeUndefined();
    });
    it("ignores an absent property", async () => {
      await expect(hook.run("mailboxes", { name: "Renamed" })).resolves.toBeUndefined();
    });
    it.each(["other", null])("ignores an invalid value for owner %s", async (owner) => {
      await expect(hook.run(owner, { connectionLimit: 0 })).resolves.toBeUndefined();
    });
  });
}
