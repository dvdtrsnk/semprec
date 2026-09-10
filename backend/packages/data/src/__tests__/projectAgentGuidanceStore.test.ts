import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { seedSystem } from "../seed/seedSystem.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { GuidanceReferenceNotFoundError } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { insertItem } from "../chokePoint/itemsStore.js";
import { createUser } from "../auth/usersStore.js";
import { NotFoundError } from "../errors.js";
import {
  createPoolClientTransactionRunner,
  guidanceReferenceStore,
  projectAgentGuidanceStore,
} from "../projectAgentGuidanceStore.js";

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

describe("projectAgentGuidanceStore (issue #214)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("returns null for a project with no guidance yet", async () => {
    const projectItemId = await createProjectItem();
    const loaded = await withTransaction(pool, (client) => projectAgentGuidanceStore.load(client, projectItemId));
    expect(loaded).toBeNull();
  });

  it("upserts, then updates in place on a second call", async () => {
    const projectItemId = await createProjectItem();
    const ownerUserId = await createTestUser();

    const created = await withTransaction(pool, (client) =>
      projectAgentGuidanceStore.upsert(client, {
        projectItemId,
        ownerUserId,
        markdown: "# Guidance v1",
      }),
    );
    expect(created.markdown).toBe("# Guidance v1");

    const updated = await withTransaction(pool, (client) =>
      projectAgentGuidanceStore.upsert(client, {
        projectItemId,
        ownerUserId,
        markdown: "# Guidance v2",
      }),
    );
    expect(updated.markdown).toBe("# Guidance v2");

    const { rows } = await pool.query(`SELECT count(*)::int AS count FROM project_agent_guidance`);
    expect(rows[0].count).toBe(1);
  });

  it("does not change the owner on a second upsert with a different ownerUserId", async () => {
    const projectItemId = await createProjectItem();
    const ownerUserId = await createTestUser();
    const otherUserId = await createTestUser();

    await withTransaction(pool, (client) =>
      projectAgentGuidanceStore.upsert(client, {
        projectItemId,
        ownerUserId,
        markdown: "# Guidance v1",
      }),
    );

    const updated = await withTransaction(pool, (client) =>
      projectAgentGuidanceStore.upsert(client, {
        projectItemId,
        ownerUserId: otherUserId,
        markdown: "# Guidance v2",
      }),
    );

    expect(updated.ownerUserId).toBe(ownerUserId);
    expect(updated.markdown).toBe("# Guidance v2");
  });

  it("transfers ownership to a new owner", async () => {
    const projectItemId = await createProjectItem();
    const ownerUserId = await createTestUser();
    const newOwnerUserId = await createTestUser();

    await withTransaction(pool, (client) =>
      projectAgentGuidanceStore.upsert(client, {
        projectItemId,
        ownerUserId,
        markdown: "# Guidance",
      }),
    );

    const transferred = await withTransaction(pool, (client) =>
      projectAgentGuidanceStore.transfer(client, projectItemId, newOwnerUserId),
    );
    expect(transferred.ownerUserId).toBe(newOwnerUserId);
  });

  it("rejects transferring guidance that doesn't exist", async () => {
    await expect(
      withTransaction(pool, (client) => projectAgentGuidanceStore.transfer(client, randomUUID(), randomUUID())),
    ).rejects.toThrow(NotFoundError);
  });

  describe("guidanceReferenceStore", () => {
    it("requireProjectsItem passes for an item in the Projects database", async () => {
      const projectItemId = await createProjectItem();
      await expect(
        withTransaction(pool, (client) => guidanceReferenceStore.requireProjectsItem(client, projectItemId)),
      ).resolves.toBeUndefined();
    });

    it("requireProjectsItem rejects an item id that doesn't exist", async () => {
      await expect(
        withTransaction(pool, (client) => guidanceReferenceStore.requireProjectsItem(client, randomUUID())),
      ).rejects.toThrow(GuidanceReferenceNotFoundError);
    });

    it("requireUser and requireUserLocale resolve for an existing user", async () => {
      const userId = await createTestUser();
      await expect(
        withTransaction(pool, (client) => guidanceReferenceStore.requireUser(client, userId)),
      ).resolves.toBeUndefined();
      const locale = await withTransaction(pool, (client) => guidanceReferenceStore.requireUserLocale(client, userId));
      expect(locale).toBe("cs");
    });

    it("requireUser rejects a user id that doesn't exist", async () => {
      await expect(
        withTransaction(pool, (client) => guidanceReferenceStore.requireUser(client, randomUUID())),
      ).rejects.toThrow(GuidanceReferenceNotFoundError);
    });
  });

  describe("createPoolClientTransactionRunner", () => {
    it("opens a transaction at the requested isolation level", async () => {
      const runner = createPoolClientTransactionRunner(pool);

      const repeatableRead = await runner.withTransaction({ isolation: "repeatable_read" }, async (client) => {
        const { rows } = await client.query<{ transaction_isolation: string }>("SHOW transaction_isolation");
        return rows[0]?.transaction_isolation;
      });
      expect(repeatableRead).toBe("repeatable read");

      const serializable = await runner.withTransaction({ isolation: "serializable" }, async (client) => {
        const { rows } = await client.query<{ transaction_isolation: string }>("SHOW transaction_isolation");
        return rows[0]?.transaction_isolation;
      });
      expect(serializable).toBe("serializable");
    });

    it("rolls back on a thrown error", async () => {
      const runner = createPoolClientTransactionRunner(pool);
      const projectItemId = await createProjectItem();
      const ownerUserId = await createTestUser();

      await expect(
        runner.withTransaction({ isolation: "serializable" }, async (client) => {
          await projectAgentGuidanceStore.upsert(client, {
            projectItemId,
            ownerUserId,
            markdown: "# Should roll back",
          });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      const loaded = await withTransaction(pool, (client) => projectAgentGuidanceStore.load(client, projectItemId));
      expect(loaded).toBeNull();
    });
  });
});
