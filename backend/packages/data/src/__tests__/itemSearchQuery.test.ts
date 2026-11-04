import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import "../domainWriteHooks.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { buildItemSearchQuery } from "../search/itemSearchQuery.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";

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

describe("shared item search query", () => {
  it("matches accent folding, prefixes, all words and treats syntax as plain text", async () => {
    await runInTenant(tenant, async () => {
      const database = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "tasks"));
      if (!database) throw new Error("Missing tasks database");
      const cp = createChokePoint(pool);
      const accounting = await cp.createItem({ databaseId: database.id, properties: { name: "Účetnictví a faktury" } });
      const send = await cp.createItem({ databaseId: database.id, properties: { name: "Odeslat fakturu" } });
      const both = await cp.createItem({ databaseId: database.id, properties: { name: "Faktura koupelna" } });
      const search = async (text: string): Promise<string[]> => {
        const query = buildItemSearchQuery(text, 2);
        // The builder emits only fixed SQL operators and numbered bind placeholders; text stays in params.
        const { rows } = await withTransaction(pool, (client) =>
          client.query<{ item_id: string }>(
            `SELECT item_id FROM item_search_index WHERE database_id = $1 AND search_vector @@ ${query.sql} ORDER BY item_id`,
            [database.id, ...query.params],
          ),
        );
        return rows.map((row) => row.item_id);
      };
      expect(await search("ucetnictvi")).toEqual([accounting.id]);
      expect(await search("odes fak")).toEqual([send.id]);
      expect(await search("faktura koupelna")).toEqual([both.id]);
      expect(await search("(faktura & | ! : ' koupelna)")).toEqual([both.id]);
      expect(await search("& | ! : ' ()")).toEqual([]);
    });
  });
});
