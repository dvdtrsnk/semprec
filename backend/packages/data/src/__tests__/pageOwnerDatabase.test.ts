import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { setAgentDatabaseGrant } from "../agentGrants/agentDatabaseGrantsAdminStore.js";
import type { AgentDatabaseAccess } from "../agentGrants/agentDatabaseGrantsStore.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { createSubpageWithClient } from "../docs/pageOperations.js";
import { assertAgentPageAccess, resolvePageOwnerDatabase } from "../docs/pageOwnerDatabase.js";
import { ensurePagesDatabase } from "../docs/pagesDatabase.js";
import { NotFoundError, ValidationError } from "../errors.js";
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

// Seeding the system databases of a tenant is the slow part of this file.
const SEEDING_TEST_TIMEOUT_MS = 120_000;
const FORBIDDEN = { status: 403, code: "forbidden" };

let admin: Pool;
let runtime: Pool;
let cp: ChokePoint;
let tenant: string;
let otherTenant: string;
let journal: DatabaseRow;

function inTenant<T>(fn: (client: PoolClient) => Promise<T>, tenantId = tenant): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(runtime, fn));
}

/** A user-created database with one live item. */
async function newHost(): Promise<{ database: DatabaseRow; itemId: string }> {
  return runInTenant(tenant, async () => {
    const database = await cp.createDatabase({ name: `Notes ${randomUUID()}` });
    await cp.createProperty({ databaseId: database.id, key: "name", name: "Name", type: "title" });
    const item = await cp.createItem({ databaseId: database.id, properties: { name: "Host" } });
    return { database, itemId: item.id };
  });
}

async function newSubpage(parentItemId: string): Promise<string> {
  const output = await inTenant((client) =>
    createSubpageWithClient(client, { parent: { itemId: parentItemId }, title: "Sub" }, "user"),
  );
  const page = output.pages[0];
  if (!page) throw new Error("Missing subpage");
  return page.pageItemId;
}

function setGrant(projectItemId: string, databaseId: string, access: AgentDatabaseAccess) {
  return inTenant((client) => setAgentDatabaseGrant(client, { projectItemId, databaseId, access }));
}

function newProject(): Promise<string> {
  return runInTenant(tenant, () => createTestProjectItem(runtime));
}

beforeAll(async () => {
  admin = getTestPool();
  runtime = await createRuntimeRolePool(admin, "semprec_data");
  await resetDatabase(admin);
  tenant = await createTestTenant(admin);
  otherTenant = await createTestTenant(admin);
  await runInTenant(tenant, () => seedSystem(runtime, createViewTypeRegistry()));
  cp = createChokePoint(runtime);
  const found = await inTenant((client) => getDatabaseByModuleId(client, JOURNAL_MODULE_ID));
  if (!found) throw new Error("The Journal database is missing");
  journal = found;
}, SEEDING_TEST_TIMEOUT_MS);

afterAll(async () => {
  const results = await Promise.allSettled([runtime?.end(), admin?.end()]);
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) throw new AggregateError(errors, "Pool cleanup failed", { cause: errors[0] });
});

describe("the database that owns a page (issue #1844)", () => {
  it("is the item's own database for the page of an item", async () => {
    const host = await newHost();
    expect(await inTenant((client) => resolvePageOwnerDatabase(client, host.itemId))).toBe(host.database.id);
  });

  it("is the database of the root host for a subpage and for a page nested in a subpage, not the Pages database", async () => {
    const host = await newHost();
    const sub = await newSubpage(host.itemId);
    const nested = await newSubpage(sub);
    const pages = await inTenant((client) => ensurePagesDatabase(client));
    expect(pages.id).not.toBe(host.database.id);
    expect(await inTenant((client) => resolvePageOwnerDatabase(client, sub))).toBe(host.database.id);
    expect(await inTenant((client) => resolvePageOwnerDatabase(client, nested))).toBe(host.database.id);
  });

  it("is the Journal database for a Journal day, and for a subpage of one", async () => {
    const day = await inTenant((client) => ensureJournalPeriodDoc(client, "day", "2026-10-16"));
    expect(await inTenant((client) => resolvePageOwnerDatabase(client, day.itemId))).toBe(journal.id);
    const sub = await newSubpage(day.itemId);
    expect(await inTenant((client) => resolvePageOwnerDatabase(client, sub))).toBe(journal.id);
  });

  it("follows a trashed host, so a trashed subpage still belongs to the host's database", async () => {
    const host = await newHost();
    const sub = await newSubpage(host.itemId);
    await runInTenant(tenant, () => cp.softDeleteItem(host.database.id, host.itemId));
    expect(await inTenant((client) => resolvePageOwnerDatabase(client, sub))).toBe(host.database.id);
  });

  it("answers not found for an unknown item, for an item of another tenant exactly as for an unknown one, and for a subpage whose host is gone", async () => {
    const foreign = await runInTenant(otherTenant, async () => {
      const database = await cp.createDatabase({ name: "Foreign" });
      return (await cp.createItem({ databaseId: database.id, properties: {} })).id;
    });
    const unknown = await inTenant((client) => resolvePageOwnerDatabase(client, randomUUID())).catch(
      (error: unknown) => error,
    );
    const crossTenant = await inTenant((client) => resolvePageOwnerDatabase(client, foreign)).catch(
      (error: unknown) => error,
    );
    const shape = (error: unknown): unknown =>
      error instanceof NotFoundError ? { status: error.status, code: error.code, message: error.message } : error;
    expect(unknown).toBeInstanceOf(NotFoundError);
    expect(shape(crossTenant)).toEqual(shape(unknown));
    expect(shape(unknown)).toEqual({ status: 404, code: "not_found", message: "Item not found" });

    const host = await newHost();
    const sub = await newSubpage(host.itemId);
    // A purge removes a host row; the API has no path that leaves its subpage behind, so this superuser delete stands
    // in for an orphan the sweep has not collected yet.
    await admin.query(`DELETE FROM items WHERE id = $1`, [host.itemId]);
    await expect(inTenant((client) => resolvePageOwnerDatabase(client, sub))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("answers not found for a Pages item whose parentItemId is not an id", async () => {
    const host = await newHost();
    const sub = await newSubpage(host.itemId);
    // The title mirror and the API always store a host id; this superuser write stands in for hand-edited data.
    await admin.query(`UPDATE items SET properties = properties - 'parentItemId' WHERE id = $1`, [sub]);
    await expect(inTenant((client) => resolvePageOwnerDatabase(client, sub))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses a stored parent cycle", async () => {
    const host = await newHost();
    const first = await newSubpage(host.itemId);
    const second = await newSubpage(first);
    // The API never reparents a page, so a cycle cannot be built through it; this superuser write stands in for
    // corrupted or hand-edited data, which is the case the walk must survive.
    await admin.query(
      `UPDATE items SET properties = jsonb_set(properties, '{parentItemId}', to_jsonb($2::text)) WHERE id = $1`,
      [first, second],
    );
    await expect(inTenant((client) => resolvePageOwnerDatabase(client, second))).rejects.toMatchObject({
      status: 400,
      details: { field: "itemId" },
    });
    await expect(inTenant((client) => resolvePageOwnerDatabase(client, second))).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("refuses a chain of more than 1000 pages and accepts one of exactly 1000", async () => {
    const host = await newHost();
    const head = await newSubpage(host.itemId);
    const pages = await inTenant((client) => ensurePagesDatabase(client));
    // A 1001-deep chain would take 1001 API calls; this superuser insert builds it with one statement. Page 1's parent
    // is the head created above, so the head is page 0 and page n has a chain of n + 1 pages.
    const { rows } = await admin.query<{ id: string; label: string }>(
      `WITH chain AS (
         SELECT n, gen_random_uuid() AS id FROM generate_series(1, 1000) AS n
       ), linked AS (
         SELECT c.n, c.id, COALESCE(p.id::text, $2::text) AS parent FROM chain c LEFT JOIN chain p ON p.n = c.n - 1
       )
       INSERT INTO items (id, tenant_id, database_id, properties)
       SELECT id, $3::uuid, $1, jsonb_build_object('title', 'p' || n, 'parentItemId', parent) FROM linked
       RETURNING id, properties->>'title' AS label`,
      [pages.id, head, tenant],
    );
    const byLabel = new Map(rows.map((row) => [row.label, row.id]));
    const tail = byLabel.get("p1000");
    const next = byLabel.get("p999");
    if (!tail || !next) throw new Error("Missing chain ends");
    await expect(inTenant((client) => resolvePageOwnerDatabase(client, tail))).rejects.toMatchObject({
      status: 400,
      details: { field: "itemId" },
    });
    expect(await inTenant((client) => resolvePageOwnerDatabase(client, next))).toBe(host.database.id);
  });
});

describe("the access of an agent's project to a page (issue #1844)", () => {
  const access = (project: string | undefined, itemId: string, required: "read" | "write") =>
    inTenant((client) => assertAgentPageAccess(client, project, itemId, required));

  it("checks nothing without a project: a person or a human session reads and writes a restricted page", async () => {
    const host = await newHost();
    const project = await newProject();
    await setGrant(project, host.database.id, "none");
    await access(undefined, host.itemId, "read");
    await access(undefined, host.itemId, "write");
    await expect(access(project, host.itemId, "read")).rejects.toMatchObject(FORBIDDEN);
  });

  it("follows the grant on the database of the item for read and write, both sides", async () => {
    const host = await newHost();
    const project = await newProject();
    await access(project, host.itemId, "write");

    await setGrant(project, host.database.id, "read");
    await access(project, host.itemId, "read");
    await expect(access(project, host.itemId, "write")).rejects.toMatchObject(FORBIDDEN);

    await setGrant(project, host.database.id, "none");
    await expect(access(project, host.itemId, "read")).rejects.toMatchObject(FORBIDDEN);

    await setGrant(project, host.database.id, "write");
    await access(project, host.itemId, "write");
  });

  it("applies the grant on the root host's database to its subpages, and one project's grant to no other project", async () => {
    const host = await newHost();
    const sub = await newSubpage(host.itemId);
    const [restricted, other] = [await newProject(), await newProject()];
    await setGrant(restricted, host.database.id, "read");
    await access(restricted, sub, "read");
    await expect(access(restricted, sub, "write")).rejects.toMatchObject(FORBIDDEN);
    await access(other, sub, "write");
  });

  it("denies the page of an item of a sensitive database by default and opens it with a grant", async () => {
    const health = await inTenant(async (client) => {
      const database = await getDatabaseByModuleId(client, "healthRecords");
      if (!database) throw new Error("The Health records database is missing");
      return database;
    });
    expect(health.sensitive).toBe(true);
    const record = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: health.id, properties: { name: "Rx" } }),
    );
    const project = await newProject();
    await expect(access(project, record.id, "read")).rejects.toMatchObject(FORBIDDEN);
    await setGrant(project, health.id, "read");
    await access(project, record.id, "read");
    await expect(access(project, record.id, "write")).rejects.toMatchObject(FORBIDDEN);
  });
});
