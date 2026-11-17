import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { z } from "zod";
import "../../domainWriteHooks.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, getTenantZeroId, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createJournalPeriodEnsureRouteHandler } from "../journalRouteHandlers.js";

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
const resultSchema = z.object({
  itemId: z.uuid(),
  docId: z.uuid(),
  period: z.string(),
  range: z.object({ from: z.string(), to: z.string() }),
});
async function ensure(type: string, period: string) {
  const result = await createJournalPeriodEnsureRouteHandler(pool)({ params: { type, period } });
  expect(result.status).toBe(200);
  return resultSchema.parse(result.body);
}

describe("journal period ensure", () => {
  it("converges concurrent first writes to one item and one page", async () =>
    runInTenant(tenant, async () => {
      const [a, b] = await Promise.all([ensure("day", "2026-10-16"), ensure("day", "2026-10-16")]);
      expect(a).toEqual(b);
      const database = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "journal"));
      if (!database) throw new Error("Missing Journal");
      const counts = await withTransaction(pool, (client) =>
        client.query<{ items: number; docs: number }>(
          `SELECT (SELECT count(*)::int FROM items WHERE database_id = $1 AND properties ->> 'period' = $2 AND deleted_at IS NULL) AS items,
              (SELECT count(*)::int FROM docs WHERE item_id = $3) AS docs`,
          [database.id, a.period, a.itemId],
        ),
      );
      expect(counts.rows).toEqual([{ items: 1, docs: 1 }]);
      expect(await ensure("day", "2026-10-16")).toEqual(a);
    }));
  it("creates canonical week and future day keys and rejects invalid periods", async () =>
    runInTenant(tenant, async () => {
      const week = await ensure("week", "2026-W53");
      expect(week.period).toBe("2026-W53");
      expect(await ensure("week", "2026-W53")).toEqual(week);
      expect((await ensure("day", "2031-05-02")).period).toBe("2031-05-02");
      expect((await ensure("day", "2027-01-01")).period).toBe("2027-01-01");
      expect((await ensure("week", "2027-W01")).period).toBe("2027-W01");
      await expect(ensure("week", "2027-W53")).rejects.toThrow();
    }));
});
