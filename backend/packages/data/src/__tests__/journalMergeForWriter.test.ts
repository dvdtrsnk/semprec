import "../domainWriteHooks.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { setAgentDatabaseGrant } from "../agentGrants/agentDatabaseGrantsAdminStore.js";
import type { AgentDatabaseAccess } from "../agentGrants/agentDatabaseGrantsStore.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { SYSTEM_WRITER } from "../chokePoint/writerKind.js";
import { withTransaction } from "../db/pool.js";
import { insertPageMarkdown, readPageMarkdown } from "../docs/pageMarkdown.js";
import { ConflictError } from "../errors.js";
import { computeJournalMergeProjection, mergeApprovedJournalDuplicates } from "../journal/journalMergeApproval.js";
import { mergeJournalDuplicatesForWriter } from "../journal/journalMergeForWriter.js";
import type { JournalPeriodType } from "../journal/journalPeriods.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { seedSystem } from "../seed/seedSystem.js";
import { JOURNAL_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import {
  createRuntimeRolePool,
  createTestProjectItem,
  createTestTenant,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import type { DatabaseRow } from "../types.js";

// `page.mergeJournalDuplicates` below the generic operation gateway (issue #2017): the merge for a writer and the
// approval projection of an agent's call. The merge itself is covered by `mergeJournalDuplicates.test.ts` (issue #1726).

// Seeding the system databases of a tenant is the slow part of this file.
const SEEDING_TEST_TIMEOUT_MS = 120_000;
const FORBIDDEN = { status: 403, code: "forbidden" };
const VALIDATION_ON_PERIOD = { status: 400, details: { field: "period" } };
const USER = {};

let admin: Pool;
let runtime: Pool;
let tenant: string;
let otherTenant: string;
let journal: DatabaseRow;
let otherJournal: DatabaseRow;
/** One calendar day per test, so no test sees the entries of another. */
let dayCounter = 0;

function inTenant<T>(fn: (client: PoolClient) => Promise<T>, tenantId = tenant): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(runtime, fn));
}

function nextDay(): string {
  dayCounter += 1;
  return `2037-03-${String(dayCounter).padStart(2, "0")}`;
}

/**
 * One live entry of a day. Two live entries of one period are a state the lazy creation never produces (it reuses the
 * live entry), so the fixture creates them directly; entries made one after the other are created first and next.
 */
async function entry(period: string, name: string, tenantId = tenant, database = journal): Promise<string> {
  return inTenant(
    async (client) =>
      (
        await createItemWithClient(
          client,
          { databaseId: database.id, properties: { name, type: "day", period } },
          { allowedSystemKeys: ["name", "type", "period"] },
        )
      ).id,
    tenantId,
  );
}

async function duplicatedDay(period = nextDay()) {
  const older = await entry(period, `\u{1F4D3} ${period} first`);
  const newer = await entry(period, `\u{1F4D3} ${period} second`);
  return { period, older, newer };
}

/** The ids of `ids` that are live in the tenant, in id order. */
async function liveOf(ids: readonly string[], tenantId = tenant): Promise<string[]> {
  return inTenant(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM items WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY id",
      [ids],
    );
    return rows.map((row) => row.id);
  }, tenantId);
}

function sorted(ids: readonly string[]): string[] {
  return [...ids].sort();
}

function mergeFor(type: JournalPeriodType, period: string, writer: { agentProjectItemId?: string } = USER) {
  return inTenant((client) => mergeJournalDuplicatesForWriter(client, { type, period }, writer));
}

function project(period: string, writer: { agentProjectItemId?: string } = {}, type: JournalPeriodType = "day") {
  return inTenant((client) =>
    computeJournalMergeProjection(client, {
      operation: "page.mergeJournalDuplicates",
      input: { type, period },
      ...(writer.agentProjectItemId === undefined ? {} : { agentProjectItemId: writer.agentProjectItemId }),
    }),
  );
}

async function setJournalSensitive(sensitive: boolean): Promise<void> {
  // A non-sensitive system database is always open and its grant rows are ignored (docs/adr/2026-11-12-per-database-agent-grants.md),
  // so the one way to make the grant on Journal decide is the flag the product sets on the Health and sleep databases.
  await admin.query(`UPDATE databases SET sensitive = $2 WHERE id = $1`, [journal.id, sensitive]);
}

function setGrant(projectItemId: string, access: AgentDatabaseAccess) {
  return inTenant((client) => setAgentDatabaseGrant(client, { projectItemId, databaseId: journal.id, access }));
}

/** What a projection must not write: the number of items and of period reservations of the tenant. */
async function writeCounts(tenantId = tenant): Promise<{ items: number; reservations: number }> {
  return inTenant(async (client) => {
    const items = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM items");
    const reservations = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM idempotency_keys");
    return { items: items.rows[0]?.n ?? -1, reservations: reservations.rows[0]?.n ?? -1 };
  }, tenantId);
}

beforeAll(async () => {
  admin = getTestPool();
  runtime = await createRuntimeRolePool(admin, "semprec_data");
  await resetDatabase(admin);
  tenant = await createTestTenant(admin);
  otherTenant = await createTestTenant(admin);
  for (const id of [tenant, otherTenant]) await runInTenant(id, () => seedSystem(runtime, createViewTypeRegistry()));
  const found = await inTenant((client) => getDatabaseByModuleId(client, JOURNAL_MODULE_ID));
  const otherFound = await inTenant((client) => getDatabaseByModuleId(client, JOURNAL_MODULE_ID), otherTenant);
  if (!found || !otherFound) throw new Error("The Journal database is missing");
  journal = found;
  otherJournal = otherFound;
}, SEEDING_TEST_TIMEOUT_MS);

afterAll(async () => {
  const results = await Promise.allSettled([runtime?.end(), admin?.end()]);
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) throw new AggregateError(errors, "Pool cleanup failed", { cause: errors[0] });
});

describe("mergeJournalDuplicatesForWriter (issue #2017)", () => {
  it("merges the two live entries of a period for a person: the older one survives, the other is in the Trash with its page appended", async () => {
    const { period, older, newer } = await duplicatedDay();
    await inTenant(async (client) => {
      await insertPageMarkdown(client, older, { placement: "end", markdown: "Older text", origin: "user" });
      await insertPageMarkdown(client, newer, { placement: "end", markdown: "Newer text", origin: "user" });
    });

    expect(await mergeFor("day", period)).toEqual({ survivorId: older, mergedItemId: newer });

    expect(await liveOf([older, newer])).toEqual([older]);
    const markdown = await inTenant(async (client) => (await readPageMarkdown(client, older)).markdown);
    expect(markdown).toContain("Older text");
    expect(markdown).toContain("Newer text");
  });

  it("answers { merged: false } and changes nothing for a period with one live entry and for a period without an entry", async () => {
    const period = nextDay();
    const only = await entry(period, `\u{1F4D3} ${period}`);
    const before = await writeCounts();

    expect(await mergeFor("day", period)).toEqual({ merged: false });
    expect(await mergeFor("day", nextDay())).toEqual({ merged: false });

    expect(await liveOf([only])).toEqual([only]);
    expect(await writeCounts()).toEqual(before);
  });

  it("refuses a malformed or non-existent period with 400 on period, merging nothing", async () => {
    const { period, older, newer } = await duplicatedDay();
    const refusals: Array<[JournalPeriodType, string]> = [
      ["week", "2027-W53"],
      ["week", "2026-W99"],
      ["month", "2026-13"],
      ["day", "2026-02-30"],
      ["day", "tomorrow"],
      ["week", period],
    ];
    for (const [type, malformed] of refusals) {
      await expect(mergeFor(type, malformed), `${type} ${malformed}`).rejects.toMatchObject(VALIDATION_ON_PERIOD);
    }
    expect(await liveOf([older, newer])).toEqual(sorted([older, newer]));
  });

  describe("the grant on the Journal database", () => {
    it("lets a project without a grant record merge the open Journal", async () => {
      const agentProjectItemId = await runInTenant(tenant, () => createTestProjectItem(runtime));
      const { period, older, newer } = await duplicatedDay();

      expect(await mergeFor("day", period, { agentProjectItemId })).toEqual({ survivorId: older, mergedItemId: newer });
    });

    it("refuses a project that may only read the restricted Journal with 403 before it validates or merges, and serves one with write access", async () => {
      const agentProjectItemId = await runInTenant(tenant, () => createTestProjectItem(runtime));
      const { period, older, newer } = await duplicatedDay();
      await setJournalSensitive(true);
      try {
        await expect(mergeFor("day", period, { agentProjectItemId })).rejects.toMatchObject(FORBIDDEN);
        await setGrant(agentProjectItemId, "read");
        await expect(mergeFor("day", period, { agentProjectItemId })).rejects.toMatchObject(FORBIDDEN);
        // A malformed period is refused after the access check, so a project that may not write learns nothing from it.
        await expect(mergeFor("day", "garbage", { agentProjectItemId })).rejects.toMatchObject(FORBIDDEN);
        expect(await liveOf([older, newer])).toEqual(sorted([older, newer]));

        await setGrant(agentProjectItemId, "write");
        expect(await mergeFor("day", period, { agentProjectItemId })).toEqual({
          survivorId: older,
          mergedItemId: newer,
        });
        expect(await liveOf([older, newer])).toEqual([older]);
      } finally {
        await setJournalSensitive(false);
      }
    });

    it("does not check a person while the Journal is restricted", async () => {
      const { period, older, newer } = await duplicatedDay();
      await setJournalSensitive(true);
      try {
        expect(await mergeFor("day", period)).toEqual({ survivorId: older, mergedItemId: newer });
      } finally {
        await setJournalSensitive(false);
      }
    });
  });

  describe("an approved merge", () => {
    function mergeApproved(
      period: string,
      approved: { survivorId: string; mergedItemId: string } | null,
    ): Promise<unknown> {
      return inTenant((client) => mergeJournalDuplicatesForWriter(client, { type: "day", period }, USER, approved));
    }

    it("merges the pair it was shown", async () => {
      const { period, older, newer } = await duplicatedDay();

      expect(await mergeApproved(period, { survivorId: older, mergedItemId: newer })).toEqual({
        survivorId: older,
        mergedItemId: newer,
      });
      expect(await liveOf([older, newer])).toEqual([older]);
    });

    it("answers { merged: false } when it was shown no pair and the period still has none", async () => {
      const period = nextDay();
      const only = await entry(period, `\u{1F4D3} ${period}`);

      expect(await mergeApproved(period, null)).toEqual({ merged: false });
      expect(await liveOf([only])).toEqual([only]);
    });

    it("throws a 409 and rolls the merge back when the pair is not the one it was shown", async () => {
      const { period, older, newer } = await duplicatedDay();
      const stranger = await entry(nextDay(), "\u{1F4D3} another day");

      await expect(mergeApproved(period, { survivorId: older, mergedItemId: stranger })).rejects.toBeInstanceOf(
        ConflictError,
      );

      expect(await liveOf([older, newer])).toEqual(sorted([older, newer]));
    });

    it("throws a 409 and rolls the merge back when it was shown no pair and the period now has one", async () => {
      const { period, older, newer } = await duplicatedDay();

      await expect(mergeApproved(period, null)).rejects.toMatchObject({ status: 409 });

      expect(await liveOf([older, newer])).toEqual(sorted([older, newer]));
    });

    it("throws a 409 when it was shown a pair and the period now has none", async () => {
      const period = nextDay();
      const only = await entry(period, `\u{1F4D3} ${period}`);
      const stranger = await entry(nextDay(), "\u{1F4D3} another day");

      await expect(mergeApproved(period, { survivorId: only, mergedItemId: stranger })).rejects.toMatchObject({
        status: 409,
      });
      expect(await liveOf([only])).toEqual([only]);
    });

    it("reads the pair of a projection through mergeApprovedJournalDuplicates, and refuses a projection that holds no pair shape", async () => {
      const { period, older, newer } = await duplicatedDay();
      const { currentResource } = await project(period);

      expect(
        await inTenant((client) =>
          mergeApprovedJournalDuplicates(client, { type: "day", period }, currentResource, USER),
        ),
      ).toEqual({ survivorId: older, mergedItemId: newer });
      await expect(
        inTenant((client) => mergeApprovedJournalDuplicates(client, { type: "day", period }, { survivorId: 1 }, USER)),
      ).rejects.toThrow("Invalid Journal merge projection");
      await expect(
        inTenant((client) => mergeApprovedJournalDuplicates(client, { type: "day", period }, undefined, USER)),
      ).rejects.toThrow("Invalid Journal merge projection");
    });
  });

  it("merges the caller's tenant only: another tenant's entries of the same period stay live", async () => {
    const { period, older, newer } = await duplicatedDay();
    const foreignOlder = await entry(period, `\u{1F4D3} ${period} first`, otherTenant, otherJournal);
    const foreignNewer = await entry(period, `\u{1F4D3} ${period} second`, otherTenant, otherJournal);

    expect(await mergeFor("day", period)).toEqual({ survivorId: older, mergedItemId: newer });

    expect(await liveOf([foreignOlder, foreignNewer], otherTenant)).toEqual(sorted([foreignOlder, foreignNewer]));
    // The other tenant's ids are not found in this one, whatever their state.
    expect(await liveOf([foreignOlder, foreignNewer])).toEqual([]);
  });
});

describe("computeJournalMergeProjection (issue #2017)", () => {
  it("names the period and the two entries by their stored titles, holds their ids in the snapshot and writes nothing", async () => {
    const { period, older, newer } = await duplicatedDay();
    await inTenant((client) =>
      insertPageMarkdown(client, newer, { placement: "end", markdown: "Private diary text", origin: "user" }),
    );
    const before = await writeCounts();

    const projection = await project(period);

    expect(projection.snapshot).toMatchObject({ kind: "journal_merge", resourceId: `day:${period}` });
    expect(projection.currentResource).toMatchObject({
      type: "day",
      period,
      survivorId: older,
      mergedItemId: newer,
      approvalDescription: {
        key: "approval.journalMerge",
        params: {
          periodType: "day",
          period,
          survivorName: `\u{1F4D3} ${period} first`,
          mergedName: `\u{1F4D3} ${period} second`,
        },
      },
    });
    expect(JSON.stringify(projection)).not.toContain("Private diary text");
    expect(await writeCounts()).toEqual(before);
  });

  it("projects a period without two live entries with no pair and no names", async () => {
    const period = nextDay();
    await entry(period, `\u{1F4D3} ${period}`);

    const projection = await project(period);

    expect(projection.currentResource).toMatchObject({
      survivorId: null,
      mergedItemId: null,
      approvalDescription: { params: { survivorName: null, mergedName: null } },
    });
  });

  it("changes the snapshot when the pair changes and keeps it when only a later entry appears", async () => {
    const { period, newer } = await duplicatedDay();
    const first = await project(period);

    await entry(period, `\u{1F4D3} ${period} third`);
    expect((await project(period)).snapshot).toEqual(first.snapshot);

    await inTenant((client) =>
      itemDeleteWithClient(client, journal.id, newer, {
        queueAffinity: createActionQueueAffinity(),
        writer: SYSTEM_WRITER,
      }),
    );
    // The third entry takes the place of the trashed one, so the pair is another one.
    expect((await project(period)).snapshot.sha256).not.toBe(first.snapshot.sha256);
  });

  it("refuses a malformed period with 400 and a project that may only read the restricted Journal with 403, and projects for one with write access", async () => {
    const agentProjectItemId = await runInTenant(tenant, () => createTestProjectItem(runtime));
    const { period, older, newer } = await duplicatedDay();
    await expect(project("2026-02-30")).rejects.toMatchObject(VALIDATION_ON_PERIOD);

    await setJournalSensitive(true);
    try {
      await expect(project(period, { agentProjectItemId })).rejects.toMatchObject(FORBIDDEN);
      await setGrant(agentProjectItemId, "read");
      await expect(project(period, { agentProjectItemId })).rejects.toMatchObject(FORBIDDEN);
      await expect(project("2026-02-30", { agentProjectItemId })).rejects.toMatchObject(FORBIDDEN);

      await setGrant(agentProjectItemId, "write");
      expect((await project(period, { agentProjectItemId })).currentResource).toMatchObject({
        survivorId: older,
        mergedItemId: newer,
      });
    } finally {
      await setJournalSensitive(false);
    }
  });

  it("sees the caller's tenant only: a period that only another tenant has duplicated projects with no pair", async () => {
    const period = nextDay();
    await entry(period, `\u{1F4D3} ${period} first`, otherTenant, otherJournal);
    await entry(period, `\u{1F4D3} ${period} second`, otherTenant, otherJournal);

    const projection = await project(period);

    expect(projection.currentResource).toMatchObject({ survivorId: null, mergedItemId: null });
  });
});
