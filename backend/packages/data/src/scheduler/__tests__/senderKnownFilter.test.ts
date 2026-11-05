import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { withTransaction } from "../../db/pool.js";
import { createPersonEmailReindexAction } from "../../mail/personLinkingActions.js";
import { writeMailboxAddresses } from "../../mail/mailboxAddresses.js";
import { upsertMailMessageMeta } from "../../mail/mailMessageMetaStore.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { parseSenderKnownFilterConfig, passesSenderKnownFilter } from "../senderKnownFilter.js";
let admin: Pool;
let data: Pool;
let own: string;
let other: string;
describe("sender-known filter", () => {
  beforeAll(async () => {
    admin = getTestPool();
    data = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("verify sender filter test role", () =>
      data.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    own = await createTestTenant(admin);
    other = await createTestTenant(admin);
    for (const tenant of [own, other]) await runInTenant(tenant, () => seedSystem(data));
  });
  afterAll(async () => {
    await data.end();
    await admin.end();
  });
  it("treats only an absent filter as disabled and rejects malformed configuration", () => {
    expect(parseSenderKnownFilterConfig(undefined)).toBeNull();
    expect(parseSenderKnownFilterConfig({})).toEqual({});
    expect(() => parseSenderKnownFilterConfig(null)).toThrow();
    expect(() => parseSenderKnownFilterConfig({ unexpected: true })).toThrow();
  });
  it("accepts known non-bulk non-own senders and fails closed for missing, bulk, unknown, own and foreign input", async () => {
    const cp = createChokePoint(data);
    const ownFixture = await runInTenant(own, async () => {
      const dbs = await cp.listDatabases();
      const db = (key: string) => {
        const found = dbs.find((entry) => entry.ownerModuleId === key);
        if (!found) throw new Error(`Missing ${key}`);
        return found;
      };
      const people = db("people"),
        emails = db("emails"),
        mailboxes = db("mailboxes");
      const person = await cp.createItem({
        databaseId: people.id,
        properties: { name: "Person", emails: "known@example.test\nown@example.test" },
      });
      const heartbeat = await data.query<{ id: string; project_item_id: string }>(
        "SELECT id, project_item_id FROM project_heartbeats WHERE name = 'newEmail'",
      );
      if (!heartbeat.rows[0]) throw new Error("Missing newEmail");
      await createPersonEmailReindexAction(data)(
        { peopleDatabaseId: people.id },
        { heartbeatId: heartbeat.rows[0].id, projectItemId: heartbeat.rows[0].project_item_id, itemId: person.id },
      );
      const mailbox = await cp.createItem({
        databaseId: mailboxes.id,
        properties: { name: "Mailbox", provider: "generic" },
      });
      await withTransaction(data, (client) =>
        writeMailboxAddresses(client, {
          mailboxesDatabaseId: mailboxes.id,
          mailboxItemId: mailbox.id,
          address: "own@example.test",
        }),
      );
      async function message(sender?: string, bulk = false) {
        const item = await cp.createItem({ databaseId: emails.id, properties: {} });
        if (sender !== undefined)
          await withTransaction(data, (client) =>
            upsertMailMessageMeta(client, {
              itemId: item.id,
              mailboxItemId: null,
              messageId: `<${randomUUID()}@example.test>`,
              envelope: { from: { address: sender } },
              isBulk: bulk,
            }),
          );
        return item.id;
      }
      return {
        known: await message("Known@Example.Test"),
        own: await message("own@example.test"),
        unknown: await message("unknown@example.test"),
        bulk: await message("known@example.test", true),
        missing: await message(),
      };
    });
    const config = parseSenderKnownFilterConfig({});
    if (!config) throw new Error("Missing filter config");
    await runInTenant(own, async () => {
      expect(await passesSenderKnownFilter(data, ownFixture.known, config)).toBe(true);
      for (const id of [ownFixture.own, ownFixture.unknown, ownFixture.bulk, ownFixture.missing, randomUUID()])
        expect(await passesSenderKnownFilter(data, id, config)).toBe(false);
    });
    await runInTenant(other, async () => {
      expect(await passesSenderKnownFilter(data, ownFixture.known, config)).toBe(false);
      expect(await passesSenderKnownFilter(data, randomUUID(), config)).toBe(false);
    });
  });
});
