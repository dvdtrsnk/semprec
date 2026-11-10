import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import {
  createRelationWithClient,
  deleteRelationWithClient,
  updateRelationWithClient,
} from "../chokePoint/relationOps.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { reconcileImapAccount, type ImapMailClient } from "../mail/imapReconcile.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { withTransaction } from "../db/pool.js";
import { seedSystem } from "../seed/seedSystem.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import type { ItemRow } from "../types.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

describe("relation invalidations", () => {
  let admin: Pool;
  let pool: Pool;
  let cp: ChokePoint;
  let tenant: string;
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    cp = createChokePoint(pool);
  });
  beforeEach(async () => {
    setInvalidationHook(() => {});
    pool.options.max = 10;
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool));
    await pool.end();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    pool.options.max = 1;
    const role = await runAsSystem("test:verify-runtime-role", () =>
      pool.query<{ role_name: string; rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT current_user::text AS role_name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ role_name: "semprec_data", rolsuper: false, rolbypassrls: false }]);
    cp = createChokePoint(pool);
  });
  afterAll(async () => {
    setInvalidationHook(() => {});
    await pool.end();
    await admin.end();
  });

  it("announces both ends after commit, deduplicates the last operation and discards rollback state on client reuse", async () =>
    runInTenant(tenant, async () => {
      const source = await cp.createDatabase({ name: "Source" });
      const target = await cp.createDatabase({ name: "Target" });
      const { property } = await cp.createRelationProperty({
        sourceDatabaseId: source.id,
        targetDatabaseId: target.id,
        key: "links",
        name: "Links",
      });
      const from = await cp.createItem({ databaseId: source.id, properties: {} });
      const targets: ItemRow[] = [];
      for (let i = 0; i < 10; i++) targets.push(await cp.createItem({ databaseId: target.id, properties: {} }));
      const firstTarget = targets[0];
      if (!firstTarget) throw new Error("Missing target");
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      const actor = randomUUID();
      const lastActor = randomUUID();
      let firstPid = 0;
      await expect(
        withTransaction(pool, async (client) => {
          const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          const row = result.rows[0];
          if (!row) throw new Error("Missing backend PID");
          firstPid = row.pid;
          await createRelationWithClient(
            client,
            { relationPropertyId: property.id, callerItemId: from.id, targetItemId: firstTarget.id },
            undefined,
            undefined,
            actor,
          );
          expect(events).toEqual([]);
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(events).toEqual([]);
      await withTransaction(pool, async (client) => {
        const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        expect(result.rows[0]?.pid).toBe(firstPid);
        for (const targetItem of targets)
          await createRelationWithClient(
            client,
            { relationPropertyId: property.id, callerItemId: from.id, targetItemId: targetItem.id },
            undefined,
            undefined,
            actor,
          );
        const first = targets[0];
        if (!first) throw new Error("Missing target");
        await deleteRelationWithClient(
          client,
          { relationPropertyId: property.id, callerItemId: from.id, targetItemId: first.id },
          undefined,
          undefined,
          lastActor,
        );
        expect(events).toEqual([]);
      });
      const sourceEvents = events.filter((event) => event.scope === "relation" && event.itemId === from.id);
      expect(sourceEvents).toEqual([
        {
          scope: "relation",
          databaseId: source.id,
          itemId: from.id,
          propertyKey: "links",
          op: "delete",
          userId: lastActor,
        },
      ]);
      expect(events.filter((event) => event.scope === "relation" && event.propertyKey === null)).toHaveLength(10);
      expect(events).toContainEqual({
        scope: "relation",
        databaseId: target.id,
        itemId: firstTarget.id,
        propertyKey: null,
        op: "delete",
        userId: lastActor,
      });
      expect(events).toContainEqual({
        scope: "relation",
        databaseId: target.id,
        itemId: targets[1]?.id,
        propertyKey: null,
        op: "put",
        userId: actor,
      });
    }));

  it("announces committed metadata replacement at both ends and ignores a missing delete", async () =>
    runInTenant(tenant, async () => {
      const source = await cp.createDatabase({ name: "Metadata source" });
      const target = await cp.createDatabase({ name: "Metadata target" });
      const { property } = await cp.createRelationProperty({
        sourceDatabaseId: source.id,
        targetDatabaseId: target.id,
        key: "links",
        name: "Links",
        inverse: { key: "backlinks", name: "Backlinks" },
      });
      const from = await cp.createItem({ databaseId: source.id, properties: {} });
      const to = await cp.createItem({ databaseId: target.id, properties: {} });
      const input = { relationPropertyId: property.id, callerItemId: from.id, targetItemId: to.id };
      await cp.createRelation(input);
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      const actor = randomUUID();
      await withTransaction(pool, async (client) => {
        await updateRelationWithClient(client, { ...input, metadata: { note: "updated" }, actingUserId: actor });
        expect(events).toEqual([]);
      });
      expect(events).toEqual([
        {
          scope: "relation",
          databaseId: source.id,
          itemId: from.id,
          propertyKey: "links",
          op: "metadata",
          userId: actor,
        },
        {
          scope: "relation",
          databaseId: target.id,
          itemId: to.id,
          propertyKey: "backlinks",
          op: "metadata",
          userId: actor,
        },
      ]);
      expect(await cp.listItemRelations(from.id, property.id)).toMatchObject([
        { targetItemId: to.id, metadata: { note: "updated" } },
      ]);
      events.length = 0;
      const absent = await withTransaction(pool, (client) =>
        deleteRelationWithClient(client, { ...input, targetItemId: randomUUID(), actingUserId: actor }),
      );
      expect(absent).toBeNull();
      expect(events).toEqual([]);
    }));

  it("coalesces ten folder edges written by a real IMAP reconciliation", async () =>
    runInTenant(tenant, async () => {
      const databases = await cp.listDatabases();
      function databaseId(moduleId: string): string {
        const database = databases.find((entry) => entry.ownerModuleId === moduleId);
        if (!database) throw new Error(`Missing ${moduleId} database`);
        return database.id;
      }
      const emailsDatabaseId = databaseId("emails");
      const foldersDatabaseId = databaseId("folders");
      const filesDatabaseId = databaseId("files");
      const mailboxesDatabaseId = databaseId("mailboxes");
      const emailProperties = await cp.listProperties(emailsDatabaseId);
      const folderProperties = await cp.listProperties(foldersDatabaseId);
      function propertyId(properties: typeof emailProperties, key: string): string {
        const property = properties.find((entry) => entry.key === key);
        if (!property) throw new Error(`Missing ${key} property`);
        return property.id;
      }
      const mailbox = await withTransaction(pool, (client) =>
        createItemWithClient(client, { databaseId: mailboxesDatabaseId, properties: { name: "Mailbox" } }),
      );
      const storage: BlobStorageWriter = {
        async writeStream() {
          throw new Error("Unexpected attachment");
        },
        async delete() {},
        readStream() {
          throw new Error("Unexpected read");
        },
      };
      const imap: ImapMailClient = {
        async appendMessage() {},
        async getCapabilities() {
          return new Set(["CONDSTORE", "QRESYNC"]);
        },
        async listFolders() {
          return [{ path: "All Mail", specialUse: "\\All" }];
        },
        async selectFolder() {
          return { uidvalidity: 1, uidnext: 2, highestModSeq: null };
        },
        async fetchMessagesSince() {
          return [
            {
              uid: 1,
              message: {
                messageId: "<labels@example.test>",
                envelope: { from: { address: "sender@example.test" } },
                subject: "Labels",
                attachments: [],
                gmailLabels: Array.from({ length: 9 }, (_, i) => `Label ${i}`),
              },
            },
          ];
        },
        async fetchVanishedSince() {
          return [];
        },
        async fetchAllUids() {
          return [1];
        },
        async fetchFlagsChangedSince() {
          return [];
        },
        async setMessageFlag() {},
        async close() {},
      };
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      const folderPropertyId = propertyId(emailProperties, "folder");
      await withTransaction(pool, (client) =>
        reconcileImapAccount(client, imap, {
          mailboxItemId: mailbox.id,
          emailsDatabaseId,
          filesDatabaseId,
          foldersDatabaseId,
          folderRelationPropertyId: folderPropertyId,
          mailboxFolderRelationPropertyId: propertyId(folderProperties, "mailbox"),
          attachmentsRelationPropertyId: propertyId(emailProperties, "attachments"),
          storage,
          storageKeyPrefix: "test",
          folderPaths: ["All Mail"],
        }),
      );
      const { rows } = await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1", [
        emailsDatabaseId,
      ]);
      expect(rows).toHaveLength(1);
      const email = rows[0];
      if (!email) throw new Error("Missing reconciled email");
      expect(await cp.listItemRelations(email.id, folderPropertyId)).toHaveLength(10);
      expect(
        events.filter(
          (event) => event.scope === "relation" && event.itemId === email.id && event.propertyKey === "folder",
        ),
      ).toHaveLength(1);
    }));
});
