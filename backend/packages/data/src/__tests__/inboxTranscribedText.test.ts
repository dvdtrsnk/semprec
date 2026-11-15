import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { createPool, withTransaction } from "../db/pool.js";
import { runTenantCutoverMigrations } from "../db/tenantCutoverMigrations.js";
import { INBOX_TRANSCRIBED_TEXT_KEY } from "../inbox/inboxVoiceNote.js";
import { runInboxTranscribedTextCutoverMigration } from "../seed/inboxTranscribedTextCutoverMigration.js";
import { seedSystem } from "../seed/seedSystem.js";
import {
  createInboxItemWithClient,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../transcription/transcriptionJob.js";

// Issue gh-1980: the system-owned `Inbox.transcribedText` property, for a fresh seed and for an existing tenant through
// the cutover, and who may write it. The job that fills it is tested in `semprec-transcribe`.

let adminPool: Pool;
let dataPool: Pool;
let chokePoint: ChokePoint;
let zero: string;
let b: string;

interface InboxPropertyRow {
  key: string;
  name: string | null;
  type: string;
  owner: string;
  owner_process: string | null;
  config: unknown;
}

const SHAPE: InboxPropertyRow = {
  key: INBOX_TRANSCRIBED_TEXT_KEY,
  name: "Transcribed text",
  type: "text",
  owner: "system",
  owner_process: "transcribe",
  config: {},
};

beforeAll(() => {
  adminPool = getTestPool();
  dataPool = createPool(process.env.TEST_DATABASE_URL ?? "", { role: "semprec_data" });
  chokePoint = createChokePoint(dataPool, undefined, createViewTypeRegistry());
});

beforeEach(async () => {
  await resetDatabase(adminPool);
  zero = getTenantZeroId();
  b = await createTestTenant(adminPool);
});

afterAll(async () => {
  await dataPool.end();
  await adminPool.end();
});

function runCutovers(): Promise<void> {
  return runAsSystem("test cutover", () => runTenantCutoverMigrations(dataPool));
}

async function inboxDatabaseId(tenantId: string): Promise<string> {
  const { rows } = await adminPool.query<{ id: string }>(
    "SELECT id FROM databases WHERE owner_module_id = 'inbox' AND tenant_id = $1",
    [tenantId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]?.id ?? "";
}

/** The Inbox properties of a tenant in key order, read through the runtime role. */
async function inboxShape(tenantId: string): Promise<InboxPropertyRow[]> {
  return runInTenant(tenantId, async () => {
    const { rows } = await dataPool.query<InboxPropertyRow>(
      `SELECT p.key, p.name, p.type, p.owner, p.owner_process, p.config
         FROM properties p JOIN databases d ON d.id = p.database_id
        WHERE d.owner_module_id = 'inbox' AND p.type <> 'relation'
        ORDER BY p.key`,
    );
    return rows;
  });
}

const transcribedRowsOf = (shape: InboxPropertyRow[]) => shape.filter((row) => row.key === INBOX_TRANSCRIBED_TEXT_KEY);

/** Seeds the tenant, then removes the property: the Inbox a populated install had before issue gh-1980. */
async function seedPreTranscriptShape(tenantId: string): Promise<string> {
  await runInTenant(tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
  const databaseId = await inboxDatabaseId(tenantId);
  // Direct SQL is the fixture: the Inbox database is schema-locked, so the public property writer refuses the delete.
  await adminPool.query("DELETE FROM properties WHERE database_id = $1 AND key = $2", [
    databaseId,
    INBOX_TRANSCRIBED_TEXT_KEY,
  ]);
  return databaseId;
}

/** The rows a cutover may change for the Inbox database: its properties and its items, read as the owner. */
async function inboxSnapshot(databaseId: string): Promise<unknown[]> {
  const { rows } = await adminPool.query<{ row: unknown }>(
    `SELECT to_jsonb(t) AS row FROM properties t WHERE database_id = $1
     UNION ALL
     SELECT to_jsonb(t) AS row FROM items t WHERE database_id = $1
     ORDER BY 1`,
    [databaseId],
  );
  return rows.map((row) => row.row);
}

async function newItem(tenantId: string, databaseId: string, text = "Existing note"): Promise<string> {
  return runInTenant(tenantId, async () => {
    const item = await withTransaction(dataPool, (client) =>
      createInboxItemWithClient(client, { inboxDatabaseId: databaseId, date: "2026-08-01", time: "08:00", text }),
    );
    return item.id;
  });
}

describe("the property of a fresh seed", () => {
  it("is a system-owned text property of the transcribe process", async () => {
    await runInTenant(zero, () => seedSystem(dataPool, createViewTypeRegistry()));

    expect(transcribedRowsOf(await inboxShape(zero))).toEqual([SHAPE]);
  });

  it("has a Czech and an English label in the Inbox catalogs", async () => {
    const labelSchema = z.record(z.string(), z.string());
    const read = async (language: string) =>
      labelSchema.parse(JSON.parse(await readFile(new URL(`../inbox/i18n/${language}.json`, import.meta.url), "utf8")));

    expect((await read("cs"))["property.inbox.transcribedText.name"]).toBe("Přepis");
    expect((await read("en"))["property.inbox.transcribedText.name"]).toBe("Transcribed text");
  });
});

describe("runInboxTranscribedTextCutoverMigration", () => {
  it("adds the property to an existing Inbox database in every tenant, with the shape a fresh seed gives", async () => {
    await seedPreTranscriptShape(zero);
    await seedPreTranscriptShape(b);
    const freshReference = await createTestTenant(adminPool);
    await runInTenant(freshReference, () => seedSystem(dataPool, createViewTypeRegistry()));
    for (const tenant of [zero, b]) expect(transcribedRowsOf(await inboxShape(tenant))).toEqual([]);

    await runCutovers();

    for (const tenant of [zero, b]) {
      expect(transcribedRowsOf(await inboxShape(tenant))).toEqual([SHAPE]);
      expect(await inboxShape(tenant)).toEqual(await inboxShape(freshReference));
    }
  });

  it("leaves the existing items without a transcript, and a second run changes nothing at all", async () => {
    const databaseId = await seedPreTranscriptShape(b);
    const itemId = await newItem(b, databaseId);
    const itemBefore = await adminPool.query("SELECT * FROM items WHERE id = $1", [itemId]);

    await runCutovers();
    const afterFirst = await inboxSnapshot(databaseId);
    await runCutovers();

    expect(await inboxSnapshot(databaseId)).toEqual(afterFirst);
    const itemAfter = await adminPool.query<{ properties: Record<string, unknown> }>(
      "SELECT * FROM items WHERE id = $1",
      [itemId],
    );
    expect(itemAfter.rows).toEqual(itemBefore.rows);
    expect(Object.hasOwn(itemAfter.rows[0]?.properties ?? {}, INBOX_TRANSCRIBED_TEXT_KEY)).toBe(false);
  });

  it("leaves a property that exists as it is", async () => {
    await runInTenant(b, () => seedSystem(dataPool, createViewTypeRegistry()));
    await adminPool.query("UPDATE properties SET name = 'Kept name' WHERE key = $1 AND tenant_id = $2", [
      INBOX_TRANSCRIBED_TEXT_KEY,
      b,
    ]);

    await runCutovers();

    expect(transcribedRowsOf(await inboxShape(b))).toEqual([{ ...SHAPE, name: "Kept name" }]);
  });

  it("changes only the tenant it runs for", async () => {
    await seedPreTranscriptShape(zero);
    await seedPreTranscriptShape(b);

    await runInTenant(b, () => runInboxTranscribedTextCutoverMigration(dataPool));

    expect(transcribedRowsOf(await inboxShape(b))).toEqual([SHAPE]);
    expect(transcribedRowsOf(await inboxShape(zero))).toEqual([]);
  });

  it("does nothing in a tenant without an Inbox database", async () => {
    await seedPreTranscriptShape(b);
    await runInTenant(b, () =>
      dataPool.query("UPDATE databases SET owner_module_id = NULL WHERE owner_module_id = 'inbox'"),
    );

    await runCutovers();

    const { rows } = await adminPool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM properties WHERE key = $1 AND tenant_id = $2",
      [INBOX_TRANSCRIBED_TEXT_KEY, b],
    );
    expect(rows[0]?.n).toBe(0);
  });
});

describe("who may write transcribedText", () => {
  /** An Inbox item of tenant `b` on a cutover tenant, so the property is the one the cutover inserted. */
  async function cutoverItem(): Promise<{ databaseId: string; itemId: string }> {
    const databaseId = await seedPreTranscriptShape(b);
    await runCutovers();
    return { databaseId, itemId: await newItem(b, databaseId) };
  }

  it("refuses a user update with 403 owner_violation and leaves the item as it is", async () => {
    const { databaseId, itemId } = await cutoverItem();
    const before = await inboxSnapshot(databaseId);

    await runInTenant(b, async () => {
      await expect(
        chokePoint.updateItem({ databaseId, itemId, propertiesPatch: { [INBOX_TRANSCRIBED_TEXT_KEY]: "Forged." } }),
      ).rejects.toMatchObject({ status: 403, code: "owner_violation" });
    });

    expect(await inboxSnapshot(databaseId)).toEqual(before);
  });

  it("refuses a user create that sets it with 403 owner_violation", async () => {
    const { databaseId } = await cutoverItem();
    const before = await inboxSnapshot(databaseId);

    await runInTenant(b, async () => {
      await expect(
        chokePoint.createItem({
          databaseId,
          properties: { date: "2026-08-02", time: "09:00", text: "Hello", [INBOX_TRANSCRIBED_TEXT_KEY]: "Forged." },
        }),
      ).rejects.toMatchObject({ status: 403, code: "owner_violation" });
    });

    expect(await inboxSnapshot(databaseId)).toEqual(before);
  });

  it("still lets the user write the text of the same item", async () => {
    const { databaseId, itemId } = await cutoverItem();

    const updated = await runInTenant(b, () =>
      chokePoint.updateItem({ databaseId, itemId, propertiesPatch: { text: "Edited by hand" } }),
    );

    expect(updated.properties).toMatchObject({ text: "Edited by hand" });
    expect(Object.hasOwn(updated.properties, INBOX_TRANSCRIBED_TEXT_KEY)).toBe(false);
  });

  it("lets the transcribe process write it, and refuses another system process", async () => {
    const { databaseId, itemId } = await cutoverItem();
    const write = (ownerProcess: string) =>
      runInTenant(b, () =>
        withTransaction(dataPool, async (client) => {
          const inbox = await getDatabaseByModuleId(client, "inbox");
          if (inbox?.id !== databaseId) throw new Error("Unexpected Inbox database");
          return updateItemWithClient(
            client,
            { databaseId, itemId, propertiesPatch: { [INBOX_TRANSCRIBED_TEXT_KEY]: "At the doctor." } },
            { allowedSystemKeys: [INBOX_TRANSCRIBED_TEXT_KEY], systemOwnerProcess: ownerProcess },
          );
        }),
      );

    await expect(write("inbox")).rejects.toMatchObject({ status: 403, code: "owner_violation" });
    const written = await write(TRANSCRIPTION_OWNER_PROCESS);

    expect(written.properties).toMatchObject({
      text: "Existing note",
      [INBOX_TRANSCRIBED_TEXT_KEY]: "At the doctor.",
    });
  });
});
