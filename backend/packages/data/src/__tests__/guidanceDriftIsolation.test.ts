import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { seedSystem } from "../seed/seedSystem.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { insertItem } from "../chokePoint/itemsStore.js";
import { createUser } from "../auth/usersStore.js";
import { createPoolClientTransactionRunner, projectAgentGuidanceStore } from "../projectAgentGuidanceStore.js";

let pool: Pool;

async function createProjectItem(): Promise<string> {
  const item = await withTransaction(pool, async (client) => {
    const database = await getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
    if (!database) throw new Error("Projects database was not seeded");
    return insertItem(client, { databaseId: database.id, properties: { name: `Project ${randomUUID()}` } });
  });
  return item.id;
}

async function createTestUser(): Promise<string> {
  const user = await createUser(pool, { email: `${randomUUID()}@example.com`, passwordHash: "hash" });
  return user.id;
}

describe("driftAction's repeatable-read snapshot (issue #85)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("keeps reading the transaction's own opening snapshot even after another connection commits a change mid-transaction", async () => {
    const projectItemId = await createProjectItem();
    const ownerUserId = await createTestUser();
    await withTransaction(pool, (client) =>
      projectAgentGuidanceStore.upsert(client, { projectItemId, ownerUserId, markdown: "# Guidance v1" }),
    );

    const runner = createPoolClientTransactionRunner(pool);

    await runner.withTransaction({ isolation: "repeatable_read" }, async (tx) => {
      // First read inside the repeatable-read transaction — this is the snapshot the rest of
      // this transaction's reads must keep seeing, no matter what commits elsewhere afterward.
      const firstRead = await projectAgentGuidanceStore.load(tx, projectItemId);
      expect(firstRead?.markdown).toBe("# Guidance v1");

      // A fully separate connection/transaction mutates and commits the same row while the
      // repeatable-read transaction above is still open.
      await withTransaction(pool, (client) =>
        projectAgentGuidanceStore.upsert(client, { projectItemId, ownerUserId, markdown: "# Guidance v2" }),
      );

      // A second read from *within the same still-open repeatable-read transaction* must still
      // return the pre-mutation snapshot — proving the isolation level actually gives
      // `driftAction.ts` one coherent view across its multiple reads, not `READ COMMITTED`'s
      // per-statement freshness (which would return "v2" here and let a manifest/guidance read
      // mix pre- and post-mutation state within a single gateway comparison).
      const secondRead = await projectAgentGuidanceStore.load(tx, projectItemId);
      expect(secondRead?.markdown).toBe("# Guidance v1");
      expect(secondRead?.updatedAt).toBe(firstRead?.updatedAt);
    });

    // Once the repeatable-read transaction above has committed (read-only, so nothing to
    // conflict with), a fresh transaction sees the committed mutation as expected.
    const afterCommit = await withTransaction(pool, (client) => projectAgentGuidanceStore.load(client, projectItemId));
    expect(afterCommit?.markdown).toBe("# Guidance v2");
  });
});
