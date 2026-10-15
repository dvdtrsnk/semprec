import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createTenantZeroUser, getTenantZeroId, withTenantTransaction } from "../testSupport/tenantFixtures.js";
import { seedSystem } from "../seed/seedSystem.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { GuidanceReferenceNotFoundError } from "@semprec/shared";
import { runAfterCommit, withTransaction } from "../db/pool.js";
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

    it("requireProjectsItem throws a plain infrastructure error, not GuidanceReferenceNotFoundError, when the Projects module database itself is missing", async () => {
      const { rows } = await pool.query<{ id: string }>(`SELECT id FROM databases WHERE owner_module_id = $1`, [
        PROJECTS_MODULE_ID,
      ]);
      const databaseId = rows[0]?.id;
      if (!databaseId) throw new Error("Projects database was not seeded");
      await pool.query(`DELETE FROM items WHERE database_id = $1`, [databaseId]);
      await pool.query(`DELETE FROM databases WHERE id = $1`, [databaseId]);

      const err = await withTransaction(pool, (client) =>
        guidanceReferenceStore.requireProjectsItem(client, randomUUID()),
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(GuidanceReferenceNotFoundError);
    });

    it("requireUser and requireUserLocale resolve for the tenant's user", async () => {
      const tenantUser = await createTenantZeroUser(pool);
      await expect(
        withTenantTransaction(pool, getTenantZeroId(), (client) =>
          guidanceReferenceStore.requireUser(client, tenantUser.id),
        ),
      ).resolves.toBeUndefined();
      const locale = await withTenantTransaction(pool, getTenantZeroId(), (client) =>
        guidanceReferenceStore.requireUserLocale(client, tenantUser.id),
      );
      expect(locale).toBe("cs");
    });

    it("requireUser rejects a user id that doesn't exist", async () => {
      await createTenantZeroUser(pool);
      await expect(
        withTenantTransaction(pool, getTenantZeroId(), (client) =>
          guidanceReferenceStore.requireUser(client, randomUUID()),
        ),
      ).rejects.toThrow(GuidanceReferenceNotFoundError);
    });

    it("requireUser and requireUserLocale reject an existing user who is not the tenant's user", async () => {
      await createTenantZeroUser(pool);
      const foreignUserId = await createTestUser();

      await expect(
        withTenantTransaction(pool, getTenantZeroId(), (client) =>
          guidanceReferenceStore.requireUser(client, foreignUserId),
        ),
      ).rejects.toThrow(GuidanceReferenceNotFoundError);
      await expect(
        withTenantTransaction(pool, getTenantZeroId(), (client) =>
          guidanceReferenceStore.requireUserLocale(client, foreignUserId),
        ),
      ).rejects.toThrow(GuidanceReferenceNotFoundError);
    });

    it("requireUser surfaces a dropped connection as itself, not as not-found", async () => {
      const connectionError = new Error("connection terminated unexpectedly");
      const brokenClient = {
        query: async () => {
          throw connectionError;
        },
      } as unknown as PoolClient;

      const err = await guidanceReferenceStore.requireUser(brokenClient, randomUUID()).catch((e: unknown) => e);

      expect(err).toBe(connectionError);
      expect(err).not.toBeInstanceOf(GuidanceReferenceNotFoundError);
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

    it("fires an after-commit callback registered inside it exactly once, after the commit", async () => {
      const runner = createPoolClientTransactionRunner(pool);
      const spy = vi.fn();

      await runner.withTransaction({ isolation: "repeatable_read" }, async (client) => {
        runAfterCommit(client, spy);
        expect(spy).not.toHaveBeenCalled();
      });

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("never fires an after-commit callback registered before a throw, not even from a later unrelated transaction", async () => {
      const runner = createPoolClientTransactionRunner(pool);
      const spy = vi.fn();

      await expect(
        runner.withTransaction({ isolation: "repeatable_read" }, async (client) => {
          runAfterCommit(client, spy);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(spy).not.toHaveBeenCalled();

      await withTransaction(pool, async () => undefined);

      expect(spy).not.toHaveBeenCalled();
    });
  });
});
