import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { writeBlock } from "@semprec/block-model";
import * as Y from "yjs";
import { z } from "zod";
import "../../domainWriteHooks.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { withTransaction } from "../../db/pool.js";
import { mutateDocWithClient } from "../../docs/docPersistence.js";
import { getOrCreateDoc, readPageStatesForItems } from "../../docs/docsStore.js";
import { seedSystem } from "../../seed/seedSystem.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../../testSupport/testDb.js";
import { createJournalPeriodReadRouteHandler } from "../journalRouteHandlers.js";
import { getOrCreateJournalItem } from "../journalStore.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
beforeAll(async () => {
  admin = getTestPool();
  pool = await createRuntimeRolePool(admin, "semprec_data");
});
beforeEach(async () => {
  await resetDatabase(admin);
  tenant = getTenantZeroId();
  await runInTenant(tenant, () => seedSystem(pool));
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});

const range = z.object({ from: z.string(), to: z.string() });
const period = z.object({
  period: z.string(),
  range,
  itemId: z.string().nullable(),
  docId: z.string().nullable(),
  markdown: z.string().nullable(),
});
const response = z.object({
  type: z.string(),
  period: z.string(),
  range,
  item: z.unknown().nullable(),
  docId: z.string().nullable(),
  markdown: z.string().nullable(),
  week: period.optional(),
  weeks: z.array(period).optional(),
  inbox: z.array(z.unknown()).optional(),
});

async function read(type: string, periodKey: string) {
  const result = await createJournalPeriodReadRouteHandler(pool)({ params: { type, period: periodKey } });
  expect(result.status).toBe(200);
  return response.parse(result.body);
}
async function journalId(): Promise<string> {
  const db = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "journal"));
  if (!db) throw new Error("Missing Journal");
  return db.id;
}

describe("journal period read", () => {
  it("reads empty days without creating rows and handles the ISO year boundary", async () =>
    runInTenant(tenant, async () => {
      const id = await journalId();
      const before = await withTransaction(pool, (client) =>
        client.query<{ count: string }>("SELECT count(*)::text AS count FROM items WHERE database_id = $1", [id]),
      );
      const day = await read("day", "2026-10-16");
      expect(day.item).toBeNull();
      expect(day.docId).toBeNull();
      expect(day.inbox).toEqual([]);
      expect(day.week).toEqual({
        period: "2026-W42",
        range: { from: "2026-10-12", to: "2026-10-18" },
        itemId: null,
        docId: null,
        markdown: null,
      });
      expect((await read("day", "2027-01-01")).week?.period).toBe("2026-W53");
      const after = await withTransaction(pool, (client) =>
        client.query<{ count: string }>("SELECT count(*)::text AS count FROM items WHERE database_id = $1", [id]),
      );
      expect(after.rows).toEqual(before.rows);
      await expect(read("week", "2027-W53")).rejects.toThrow();
      await expect(read("other", "2026")).rejects.toThrow();
    }));
  it(
    "reads pending page updates in one batch without compacting or writing",
    async () =>
      runInTenant(tenant, async () => {
        const id = await journalId();
        const week = await withTransaction(pool, (client) =>
          getOrCreateJournalItem(client, id, "week", new Date("2026-10-01T12:00:00Z"), "Europe/Prague"),
        );
        const doc = await withTransaction(pool, (client) => getOrCreateDoc(client, week.id, "page"));
        await withTransaction(pool, async (client) => {
          for (let i = 0; i < 201; i++) {
            await mutateDocWithClient(
              client,
              doc.id,
              "user",
              (ydoc) => writeBlock(ydoc, { id: "body", type: "text", text: `Version ${i}` }),
              Infinity,
            );
          }
        });
        const fingerprint = async () =>
          withTransaction(pool, async (client) => {
            const { rows } = await client.query<{ snapshots: string; updates: string; history: string; docs: string }>(
              `SELECT (SELECT md5(coalesce(string_agg(s::text, '' ORDER BY doc_id), '')) FROM doc_snapshots s WHERE doc_id = $1) AS snapshots,
                  (SELECT md5(coalesce(string_agg(u::text, '' ORDER BY id), '')) FROM doc_updates u WHERE doc_id = $1) AS updates,
                  (SELECT md5(coalesce(string_agg(h::text, '' ORDER BY update_id), '')) FROM doc_history_updates h WHERE doc_id = $1) AS history,
                  (SELECT md5(coalesce(string_agg(d::text, '' ORDER BY id), '')) FROM docs d WHERE id = $1) AS docs`,
              [doc.id],
            );
            return rows[0];
          });
        const before = await fingerprint();
        const statements: string[] = [];
        const observed = new Proxy(pool, {
          get(target, key, receiver) {
            if (key !== "connect") return Reflect.get(target, key, receiver);
            return async () => {
              const client = await target.connect();
              return new Proxy(client, {
                get(inner, property, original) {
                  if (property !== "query") return Reflect.get(inner, property, original);
                  return new Proxy(inner.query.bind(inner), {
                    apply(fn, receiverValue, args: unknown[]) {
                      if (typeof args[0] === "string") statements.push(args[0]);
                      return Reflect.apply(fn, receiverValue, args);
                    },
                  });
                },
              });
            };
          },
        });
        const result = await createJournalPeriodReadRouteHandler(observed)({
          params: { type: "month", period: "2026-10" },
        });
        const month = response.parse(result.body);
        expect(month.weeks?.find((value) => value.period === "2026-W40")?.markdown).toBe("Version 200");
        expect(statements.filter((sql) => sql.includes("FROM docs d") && sql.includes("doc_snapshots"))).toHaveLength(
          1,
        );
        expect(await fingerprint()).toEqual(before);
        expect((await read("day", "2026-10-01")).week?.markdown).toBe("Version 200");
      }),
    30000,
  );

  it("retains the primary page decode error if cleanup also fails", async () =>
    runInTenant(tenant, async () => {
      const id = await journalId();
      const item = await withTransaction(pool, (client) =>
        getOrCreateJournalItem(client, id, "week", new Date("2026-10-01T12:00:00Z"), "Europe/Prague"),
      );
      const doc = await withTransaction(pool, (client) => getOrCreateDoc(client, item.id, "page"));
      // The normal document writer cannot persist a malformed Yjs snapshot; inject corruption in this disposable fixture.
      const changed = await withTransaction(pool, (client) =>
        client.query("UPDATE doc_snapshots SET state = $2 WHERE doc_id = $1", [doc.id, Buffer.from([255])]),
      );
      expect(changed.rowCount).toBe(1);
      const cleanup = new Error("injected cleanup failure");
      const destroy: unknown = Object.getOwnPropertyDescriptor(Y.Doc.prototype, "destroy")?.value;
      if (typeof destroy !== "function") throw new Error("Missing Y.Doc destroy");
      const spy = vi.spyOn(Y.Doc.prototype, "destroy").mockImplementation(function (this: Y.Doc) {
        Reflect.apply(destroy, this, []);
        throw cleanup;
      });
      try {
        await expect(read("week", "2026-W40")).rejects.toSatisfy(
          (error: unknown) =>
            error instanceof AggregateError &&
            error.errors.length === 2 &&
            error.errors[1] === cleanup &&
            error.cause === error.errors[0],
        );
      } finally {
        spy.mockRestore();
      }
    }));

  it("batch page reads include the owning tenant and exclude foreign and random item ids", async () => {
    const other = await createTestTenant(admin);
    await runInTenant(other, () => seedSystem(pool));
    const makePage = (tenantId: string) =>
      runInTenant(tenantId, async () => {
        const id = await journalId();
        const item = await withTransaction(pool, (client) =>
          getOrCreateJournalItem(client, id, "week", new Date("2026-10-01T12:00:00Z"), "Europe/Prague"),
        );
        await withTransaction(pool, (client) => getOrCreateDoc(client, item.id, "page"));
        return item.id;
      });
    const own = await makePage(tenant);
    const foreign = await makePage(other);
    const rows = await runInTenant(tenant, () =>
      withTransaction(pool, (client) =>
        readPageStatesForItems(client, [own, foreign, "00000000-0000-0000-0000-000000000000"]),
      ),
    );
    expect(rows.map((row) => row.itemId)).toEqual([own]);
  });

  it("resolves month weeks in order and prefers a live reservation", async () =>
    runInTenant(tenant, async () => {
      const id = await journalId();
      const week = await withTransaction(pool, (client) =>
        getOrCreateJournalItem(client, id, "week", new Date("2026-10-01T12:00:00Z"), "Europe/Prague"),
      );
      const doc = await withTransaction(pool, (client) => getOrCreateDoc(client, week.id, "page"));
      const reserved = await withTransaction(pool, (client) =>
        getOrCreateJournalItem(client, id, "day", new Date("2026-10-16T12:00:00Z"), "Europe/Prague"),
      );
      await withTransaction(pool, (client) =>
        createItemWithClient(
          client,
          { databaseId: id, properties: { name: "Duplicate", type: "day", period: "2026-10-16" } },
          { allowedSystemKeys: ["name", "type", "period"] },
        ),
      );
      const month = await read("month", "2026-10");
      expect(month.weeks).toHaveLength(5);
      expect(month.weeks?.[0]).toEqual({
        period: "2026-W40",
        range: { from: "2026-09-28", to: "2026-10-04" },
        itemId: week.id,
        docId: doc.id,
        markdown: "",
      });
      expect((await read("quarter", "2026-Q4")).range).toEqual({ from: "2026-10-01", to: "2026-12-31" });
      const day = await read("day", "2026-10-16");
      expect(z.object({ id: z.string() }).parse(day.item).id).toBe(reserved.id);
    }));
});
