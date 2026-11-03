import "../domainWriteHooks.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { getOrCreateJournalItem } from "../journal/journalStore.js";
import { createInboxItemWithClient } from "../inbox/inboxStore.js";
import { ForbiddenError } from "../errors.js";

let pool: Pool;
let chokePoint: ChokePoint;

// The owning-process grant getOrCreateJournalItem uses: `type` and `period` are owner:'system' and
// only Journal's own lazy creation may write them. Passing it lets a test reach the hook's checks.
const JOURNAL_SYSTEM_KEYS = { allowedSystemKeys: ["name", "type", "period"] } as const;

/** The hook's refusal: a 403 `forbidden` that names the first missing key, checked in `type`, `period` order. */
function refusalFor(field: "type" | "period") {
  return { status: 403, code: "forbidden", details: { field } };
}

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

async function entryCount(databaseId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [
    databaseId,
  ]);
  return rows[0]?.n ?? -1;
}

describe("Journal create hook: an entry must carry its type and period", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    const viewTypeRegistry = createViewTypeRegistry();
    chokePoint = createChokePoint(pool, undefined, viewTypeRegistry);
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("a create that writes no properties is refused with 403 on type and stores no row", async () => {
    const journalId = await databaseIdFor("journal");

    let failure: unknown;
    try {
      await chokePoint.createItem({ databaseId: journalId, properties: {} });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ForbiddenError);
    expect(failure).toMatchObject(refusalFor("type"));
    expect(await entryCount(journalId)).toBe(0);
  });

  it.each([
    ["no period", { type: "day" }, "period"],
    ["an empty period", { type: "day", period: "" }, "period"],
    ["a blank period", { type: "day", period: "   " }, "period"],
    ["no type", { period: "2026-08-28" }, "type"],
    ["a null type", { type: null, period: "2026-08-28" }, "type"],
  ] as const)(
    "a system write with %s is refused with 403 on %s and rolls the row back",
    async (_label, properties, field) => {
      const journalId = await databaseIdFor("journal");

      await expect(
        withTransaction(pool, (client) =>
          createItemWithClient(client, { databaseId: journalId, properties }, JOURNAL_SYSTEM_KEYS),
        ),
      ).rejects.toMatchObject(refusalFor(field));
      expect(await entryCount(journalId)).toBe(0);
    },
  );

  it("a refused create releases its idempotency key, so a corrected retry with the same key creates the entry", async () => {
    const journalId = await databaseIdFor("journal");
    const idempotencyKey = `journal-hook-retry-${journalId}`;

    await expect(
      withTransaction(pool, (client) =>
        createItemWithClient(client, { databaseId: journalId, properties: {}, idempotencyKey }, JOURNAL_SYSTEM_KEYS),
      ),
    ).rejects.toMatchObject(refusalFor("type"));

    const retried = await withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        { databaseId: journalId, properties: { type: "day", period: "2026-08-28" }, idempotencyKey },
        JOURNAL_SYSTEM_KEYS,
      ),
    );
    expect(retried.properties).toMatchObject({ type: "day", period: "2026-08-28" });
    expect(await entryCount(journalId)).toBe(1);
  });

  it("a day entry written by getOrCreateJournalItem carries its type and period and passes", async () => {
    const journalId = await databaseIdFor("journal");

    const entry = await withTransaction(pool, (client) =>
      getOrCreateJournalItem(client, journalId, "day", new Date("2026-08-28T10:00:00Z"), "Europe/Prague"),
    );

    expect(entry.properties).toMatchObject({ type: "day", period: "2026-08-28" });
    expect(await entryCount(journalId)).toBe(1);
  });

  it("a repeated getOrCreateJournalItem for the same period returns the existing entry", async () => {
    const journalId = await databaseIdFor("journal");

    const first = await withTransaction(pool, (client) =>
      getOrCreateJournalItem(client, journalId, "day", new Date("2026-08-28T10:00:00Z"), "Europe/Prague"),
    );
    const second = await withTransaction(pool, (client) =>
      getOrCreateJournalItem(client, journalId, "day", new Date("2026-08-28T18:00:00Z"), "Europe/Prague"),
    );

    expect(second.id).toBe(first.id);
    expect(await entryCount(journalId)).toBe(1);
  });

  it("an Inbox capture still succeeds and creates the day entry it is linked to", async () => {
    const inboxId = await databaseIdFor("inbox");
    const journalId = await databaseIdFor("journal");

    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        date: "2026-08-28",
        time: "09:00",
        text: "Buy milk",
      }),
    );

    expect(item.databaseId).toBe(inboxId);
    const { rows } = await pool.query<{ period: string; type: string }>(
      "SELECT properties ->> 'period' AS period, properties ->> 'type' AS type FROM items WHERE database_id = $1",
      [journalId],
    );
    expect(rows).toEqual([{ period: "2026-08-28", type: "day" }]);
  });

  it("a create in a database that is not Journal is not refused for a missing type or period", async () => {
    const projectsId = await databaseIdFor("projects");

    const item = await chokePoint.createItem({ databaseId: projectsId, properties: {} });

    expect(item.databaseId).toBe(projectsId);
  });
});
