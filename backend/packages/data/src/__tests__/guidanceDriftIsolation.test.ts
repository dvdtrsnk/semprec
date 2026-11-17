import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";
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
  // Tenant zero's user: guidance may only be owned by its own tenant's user.
  const user = await createUser(pool, {
    email: `${randomUUID()}@example.com`,
    passwordHash: "hash",
    tenantId: getTenantZeroId(),
  });
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
      // First read inside the repeatable-read transaction: the snapshot later reads must keep seeing.
      const firstRead = await projectAgentGuidanceStore.load(tx, projectItemId);
      expect(firstRead?.markdown).toBe("# Guidance v1");

      await withTransaction(pool, (client) =>
        projectAgentGuidanceStore.upsert(client, { projectItemId, ownerUserId, markdown: "# Guidance v2" }),
      );

      // A second read in the same repeatable-read transaction still returns the pre-mutation snapshot, so
      // `driftAction.ts` gets one coherent view across its reads (READ COMMITTED would return "v2" here).
      const secondRead = await projectAgentGuidanceStore.load(tx, projectItemId);
      expect(secondRead?.markdown).toBe("# Guidance v1");
      expect(secondRead?.updatedAt).toBe(firstRead?.updatedAt);
    });

    const afterCommit = await withTransaction(pool, (client) => projectAgentGuidanceStore.load(client, projectItemId));
    expect(afterCommit?.markdown).toBe("# Guidance v2");
  });
});
