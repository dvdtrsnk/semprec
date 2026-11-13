import "../domainWriteHooks.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { listMcpToolRegistrationsForServer } from "../mcp/mcpToolRegistrationsStore.js";
import { syncMcpServerTools } from "../mcp/mcpSync.js";
import type { McpConnectionConfig } from "../mcp/mcpConnectionConfig.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import { seedSystem } from "../seed/seedSystem.js";
import {
  allowLoopbackOutboundForTests,
  startHttpContractServer,
  type McpContractServer,
} from "../testSupport/mcpContractServers.js";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";

let pool: Pool;
let cp: ChokePoint;
let mcpServersId: string;
let events: InvalidationEvent[];
let restoreOutboundPolicy: () => void;

async function mcpServersDatabaseId(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = 'mcpServers'");
  if (!rows[0]) throw new Error("The mcpServers database was not seeded");
  return rows[0].id;
}

/** A server item written the way the sync tests write one: straight into the store, so that no write hook runs for it. */
async function createServer(connectionConfig: McpConnectionConfig): Promise<string> {
  const item = await withTransaction(pool, (client) =>
    itemsStore.insertItem(client, {
      databaseId: mcpServersId,
      properties: { name: "Contract server", connectionConfig },
    }),
  );
  return item.id;
}

/** Updates one server item inside a transaction of its own, rolling it back on request. */
const patchServer = (itemId: string, propertiesPatch: Record<string, unknown>, rollBack = false) =>
  withTransaction(pool, async (client) => {
    await updateItemWithClient(client, { databaseId: mcpServersId, itemId, propertiesPatch });
    if (rollBack) throw new Error("force rollback");
  });

const serverEvents = () => events.filter((event) => event.scope === "mcpServers");

describe("the mcpServers invalidation (issue #2025)", () => {
  beforeAll(() => {
    // The http contract server listens on loopback, which the default outbound policy refuses.
    restoreOutboundPolicy = allowLoopbackOutboundForTests();
  });

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    cp = createChokePoint(pool);
    mcpServersId = await mcpServersDatabaseId();
    events = [];
    setInvalidationHook((event) => events.push(event));
  });

  afterEach(() => {
    setInvalidationHook(() => {});
  });

  afterAll(async () => {
    restoreOutboundPolicy();
    await pool?.end();
  });

  describe("switching a server on or off", () => {
    it("announces once when active is switched off and once when it is switched on, with no id", async () => {
      const itemId = await createServer({ transport: "http", url: "https://mcp.example.test/mcp" });

      await patchServer(itemId, { active: false });
      expect(serverEvents()).toEqual([{ scope: "mcpServers" }]);
      await patchServer(itemId, { active: true });

      expect(serverEvents()).toEqual([{ scope: "mcpServers" }, { scope: "mcpServers" }]);
    });

    it("announces nothing for an update of a server that does not name active", async () => {
      const itemId = await createServer({ transport: "http", url: "https://mcp.example.test/mcp" });

      await patchServer(itemId, { name: "Renamed server" });

      expect(serverEvents()).toEqual([]);
      // The update itself was written and announced as an item write.
      expect(events.some((event) => event.scope === "item" && event.itemId === itemId)).toBe(true);
    });

    it("announces nothing when the transaction that switched the server off rolls back", async () => {
      const itemId = await createServer({ transport: "http", url: "https://mcp.example.test/mcp" });

      await expect(patchServer(itemId, { active: false }, true)).rejects.toThrow("force rollback");

      expect(serverEvents()).toEqual([]);
    });

    it("announces nothing for a patch that names active on an item of another database", async () => {
      const database = await cp.createDatabase({ name: "Plain database" });
      await cp.createProperty({ databaseId: database.id, key: "active", name: "Active", type: "checkbox" });
      const item = await cp.createItem({ databaseId: database.id, properties: {} });

      await cp.updateItem({ databaseId: database.id, itemId: item.id, propertiesPatch: { active: true } });

      expect(events.some((event) => event.scope === "item" && event.itemId === item.id)).toBe(true);
      expect(serverEvents()).toEqual([]);
    });
  });

  describe("synchronizing the tools of a server", () => {
    async function withContractServer(work: (contract: McpContractServer, itemId: string) => Promise<void>) {
      const contract = await startHttpContractServer();
      try {
        await work(contract, await createServer(contract.connectionConfig));
      } finally {
        await contract.stop();
      }
    }

    it("announces once after a successful synchronization", async () => {
      await withContractServer(async (_contract, itemId) => {
        await syncMcpServerTools(pool, itemId);

        expect(await listMcpToolRegistrationsForServer(pool, itemId)).toHaveLength(1);
        expect(serverEvents()).toEqual([{ scope: "mcpServers" }]);
      });
    });

    it("announces nothing when the response is refused before anything is written", async () => {
      await withContractServer(async (contract, itemId) => {
        contract.setTools([
          { name: "dup", description: "one", inputSchema: { type: "object", properties: {} } },
          { name: "dup", description: "two", inputSchema: { type: "object", properties: {} } },
        ]);

        await expect(syncMcpServerTools(pool, itemId)).rejects.toThrow();

        expect(await listMcpToolRegistrationsForServer(pool, itemId)).toEqual([]);
        expect(serverEvents()).toEqual([]);
      });
    });

    it("announces nothing when the server cannot be reached", async () => {
      const contract = await startHttpContractServer();
      const connectionConfig = contract.connectionConfig;
      await contract.stop();
      const itemId = await createServer(connectionConfig);

      await expect(syncMcpServerTools(pool, itemId)).rejects.toThrow();

      expect(serverEvents()).toEqual([]);
    });

    it("announces nothing when the transaction that writes the registrations rolls back", async () => {
      // A trigger that rejects the write of `syncStatus: 'ok'`, the last statement of the registrations' transaction.
      await pool.query(`
        CREATE FUNCTION test_mcp_sync_reject_ok() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.properties->>'syncStatus' = 'ok' THEN
            RAISE EXCEPTION 'simulated registration failure';
          END IF;
          RETURN NEW;
        END $$`);
      await pool.query(
        "CREATE TRIGGER test_mcp_sync_reject_ok BEFORE UPDATE ON items FOR EACH ROW EXECUTE FUNCTION test_mcp_sync_reject_ok()",
      );
      try {
        await withContractServer(async (_contract, itemId) => {
          await expect(syncMcpServerTools(pool, itemId)).rejects.toThrow("simulated registration failure");

          // The upserts of the same transaction were rolled back with it.
          expect(await listMcpToolRegistrationsForServer(pool, itemId)).toEqual([]);
          expect(serverEvents()).toEqual([]);
        });
      } finally {
        await pool.query("DROP TRIGGER test_mcp_sync_reject_ok ON items");
        await pool.query("DROP FUNCTION test_mcp_sync_reject_ok()");
      }
    });
  });
});
