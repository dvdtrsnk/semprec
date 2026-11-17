import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { createPool, withTransaction } from "../db/pool.js";
import { INBOX_TRANSCRIBED_TEXT_KEY } from "../inbox/inboxVoiceNote.js";
import { seedSystem } from "../seed/seedSystem.js";
import {
  createInboxItemWithClient,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../transcription/transcriptionJob.js";

// Issue gh-1980: the system-owned `Inbox.transcribedText` property of a fresh seed, and who may write it. The job that fills it is tested in `semprec-transcribe`.

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

/** The rows of the Inbox database: its properties and its items, read as the owner. */
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

describe("who may write transcribedText", () => {
  /** An Inbox item of a freshly seeded tenant `b`. */
  async function seededItem(): Promise<{ databaseId: string; itemId: string }> {
    await runInTenant(b, () => seedSystem(dataPool, createViewTypeRegistry()));
    const databaseId = await inboxDatabaseId(b);
    return { databaseId, itemId: await newItem(b, databaseId) };
  }

  it("refuses a user update with 403 owner_violation and leaves the item as it is", async () => {
    const { databaseId, itemId } = await seededItem();
    const before = await inboxSnapshot(databaseId);

    await runInTenant(b, async () => {
      await expect(
        chokePoint.updateItem({ databaseId, itemId, propertiesPatch: { [INBOX_TRANSCRIBED_TEXT_KEY]: "Forged." } }),
      ).rejects.toMatchObject({ status: 403, code: "owner_violation" });
    });

    expect(await inboxSnapshot(databaseId)).toEqual(before);
  });

  it("refuses a user create that sets it with 403 owner_violation", async () => {
    const { databaseId } = await seededItem();
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
    const { databaseId, itemId } = await seededItem();

    const updated = await runInTenant(b, () =>
      chokePoint.updateItem({ databaseId, itemId, propertiesPatch: { text: "Edited by hand" } }),
    );

    expect(updated.properties).toMatchObject({ text: "Edited by hand" });
    expect(Object.hasOwn(updated.properties, INBOX_TRANSCRIBED_TEXT_KEY)).toBe(false);
  });

  it("lets the transcribe process write it, and refuses another system process", async () => {
    const { databaseId, itemId } = await seededItem();
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
