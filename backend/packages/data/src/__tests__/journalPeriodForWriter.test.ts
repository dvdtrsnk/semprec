import "../domainWriteHooks.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { setAgentDatabaseGrant } from "../agentGrants/agentDatabaseGrantsAdminStore.js";
import type { AgentDatabaseAccess } from "../agentGrants/agentDatabaseGrantsStore.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { ensureJournalPeriodForWriter } from "../journal/journalPeriodForWriter.js";
import { ensureJournalPeriodDoc } from "../journal/journalStore.js";
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
import type { JournalPeriodType } from "../journal/journalPeriods.js";

// Seeding the system databases of a tenant is the slow part of this file.
const SEEDING_TEST_TIMEOUT_MS = 120_000;
const FORBIDDEN = { status: 403, code: "forbidden" };
const USER = {};

let admin: Pool;
let runtime: Pool;
let tenant: string;
let otherTenant: string;
let journal: DatabaseRow;

function inTenant<T>(fn: (client: PoolClient) => Promise<T>, tenantId = tenant): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(runtime, fn));
}

function ensure(
  type: JournalPeriodType,
  selector: { date?: string; period?: string },
  writer: { agentProjectItemId?: string } = USER,
  tenantId = tenant,
) {
  return inTenant((client) => ensureJournalPeriodForWriter(client, type, selector, writer), tenantId);
}

/** The live Journal entries with the period key `period`, of `type` when one is given. */
async function journalEntryCount(period: string, tenantId = tenant, type?: JournalPeriodType): Promise<number> {
  return inTenant(async (client) => {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM items
       WHERE properties ->> 'period' = $1 AND ($2::text IS NULL OR properties ->> 'type' = $2) AND deleted_at IS NULL`,
      [period, type ?? null],
    );
    return rows[0]?.n ?? -1;
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
  if (!found) throw new Error("The Journal database is missing");
  journal = found;
}, SEEDING_TEST_TIMEOUT_MS);

afterAll(async () => {
  const results = await Promise.allSettled([runtime?.end(), admin?.end()]);
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) throw new AggregateError(errors, "Pool cleanup failed", { cause: errors[0] });
});

describe("ensureJournalPeriodForWriter (issue #1861)", () => {
  it("turns a calendar date into the period of each type that contains it and creates its entry and page", async () => {
    const cases: Array<[JournalPeriodType, string, string, string]> = [
      ["day", "2026-10-16", "2026-10-16", "2026-10-16"],
      ["week", "2026-10-16", "2026-W42", "2026-10-12"],
      ["month", "2026-10-16", "2026-10", "2026-10-01"],
      ["quarter", "2026-10-16", "2026-Q4", "2026-10-01"],
      ["year", "2026-10-16", "2026", "2026-01-01"],
    ];
    for (const [type, date, period, from] of cases) {
      const ensured = await ensure(type, { date });
      expect(ensured, type).toMatchObject({ period, range: { from } });
      expect(await journalEntryCount(period), type).toBe(1);
    }
  });

  it("puts a date at a year boundary in the ISO week it belongs to, whatever the calendar year says", async () => {
    expect((await ensure("week", { date: "2027-01-01" })).period).toBe("2026-W53");
    expect((await ensure("week", { date: "2024-12-30" })).period).toBe("2025-W01");
  });

  it("takes a canonical period key as it is, and a date and its key name the same entry", async () => {
    const byKey = await ensure("week", { period: "2031-W10" });
    const byDate = await ensure("week", { date: "2031-03-03" });
    expect(byKey.period).toBe("2031-W10");
    expect(byDate).toEqual(byKey);
  });

  it("returns the existing live entry instead of a second one, also for a writer that is an agent project", async () => {
    const project = await runInTenant(tenant, () => createTestProjectItem(runtime));
    const existing = await inTenant((client) => ensureJournalPeriodDoc(client, "day", "2032-02-29"));
    const again = await ensure("day", { period: "2032-02-29" }, { agentProjectItemId: project });
    expect(again).toEqual(existing);
    expect(await journalEntryCount("2032-02-29")).toBe(1);
  });

  it("refuses naming both or neither of a date and a period with a ValidationError on period, creating nothing", async () => {
    for (const selector of [{}, { date: "2033-05-05", period: "2033-05-05" }]) {
      await expect(ensure("day", selector)).rejects.toMatchObject({ status: 400, details: { field: "period" } });
    }
    expect(await journalEntryCount("2033-05-05")).toBe(0);
  });

  it("refuses a malformed or non-existent period, or one of another type, with 400 and creates nothing", async () => {
    const refusals: Array<[JournalPeriodType, string]> = [
      ["week", "2027-W53"],
      ["week", "2026-W99"],
      ["month", "2026-13"],
      ["day", "2026-02-30"],
      ["day", "tomorrow"],
      ["week", "2026-10-16"],
    ];
    for (const [type, period] of refusals) {
      await expect(ensure(type, { period }), `${type} ${period}`).rejects.toMatchObject({
        status: 400,
        details: { field: "period" },
      });
      expect(await journalEntryCount(period, tenant, type), `${type} ${period}`).toBe(0);
    }
  });

  describe("the grant on the Journal database", () => {
    async function setJournalSensitive(sensitive: boolean): Promise<void> {
      // A non-sensitive system database is always open and its grant rows are ignored (docs/adr/2026-11-12-per-database-agent-grants.md),
      // so the one way to make the grant on Journal decide is the flag the product sets on the Health and sleep databases.
      await admin.query(`UPDATE databases SET sensitive = $2 WHERE id = $1`, [journal.id, sensitive]);
    }

    function setGrant(projectItemId: string, access: AgentDatabaseAccess) {
      return inTenant((client) => setAgentDatabaseGrant(client, { projectItemId, databaseId: journal.id, access }));
    }

    it("lets a project without a grant record write the open Journal, and a person or a human /mcp session without a project", async () => {
      const project = await runInTenant(tenant, () => createTestProjectItem(runtime));
      expect((await ensure("day", { date: "2034-01-01" }, { agentProjectItemId: project })).period).toBe("2034-01-01");
      expect((await ensure("day", { date: "2034-01-02" })).period).toBe("2034-01-02");
    });

    it("refuses a project that may only read the restricted Journal with 403 before creating anything, and serves one with write access", async () => {
      const project = await runInTenant(tenant, () => createTestProjectItem(runtime));
      await setJournalSensitive(true);
      try {
        await expect(ensure("day", { date: "2035-01-01" }, { agentProjectItemId: project })).rejects.toMatchObject(
          FORBIDDEN,
        );
        await setGrant(project, "read");
        await expect(ensure("day", { date: "2035-01-01" }, { agentProjectItemId: project })).rejects.toMatchObject(
          FORBIDDEN,
        );
        // A malformed period is refused after the access check, so a project that may not write learns nothing from it.
        await expect(ensure("day", { period: "garbage" }, { agentProjectItemId: project })).rejects.toMatchObject(
          FORBIDDEN,
        );
        expect(await journalEntryCount("2035-01-01")).toBe(0);

        // A person is not checked even while the Journal is restricted.
        expect((await ensure("day", { date: "2035-01-03" })).period).toBe("2035-01-03");

        await setGrant(project, "write");
        expect((await ensure("day", { date: "2035-01-01" }, { agentProjectItemId: project })).period).toBe(
          "2035-01-01",
        );
        expect(await journalEntryCount("2035-01-01")).toBe(1);
      } finally {
        await setJournalSensitive(false);
      }
    });
  });

  it("keeps a tenant's entries to itself: another tenant's call for the same period gets its own entry and page", async () => {
    const [mine, theirs] = [
      await ensure("day", { date: "2036-06-06" }),
      await ensure("day", { date: "2036-06-06" }, USER, otherTenant),
    ];
    expect(theirs.itemId).not.toBe(mine.itemId);
    expect(theirs.docId).not.toBe(mine.docId);
    expect(await journalEntryCount("2036-06-06")).toBe(1);
    expect(await journalEntryCount("2036-06-06", otherTenant)).toBe(1);
    // An id of the other tenant is not found in this one.
    const { rows } = await inTenant((client) =>
      client.query<{ n: number }>(`SELECT count(*)::int AS n FROM items WHERE id = $1`, [theirs.itemId]),
    );
    expect(rows[0]?.n).toBe(0);
  });
});
