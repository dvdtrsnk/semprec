import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { parseMarkdown } from "@semprec/block-model";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { withTransaction } from "../db/pool.js";
import { createDatabase } from "../chokePoint/databasesStore.js";
import { insertItem, softDeleteItem } from "../chokePoint/itemsStore.js";
import { assertItemLinksExist } from "../docs/assertItemLinksExist.js";
import { ValidationError } from "../errors.js";

let admin: Pool;
let runtime: Pool;
let setupCleanupAttempted = false;
beforeAll(async () => {
  admin = getTestPool();
  try {
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  } catch (error) {
    setupCleanupAttempted = true;
    let cleanupFailure: { error: unknown } | undefined;
    try {
      await admin.end();
    } catch (cleanup) {
      cleanupFailure = { error: cleanup };
    }
    if (cleanupFailure)
      throw new AggregateError([error, cleanupFailure.error], "Runtime pool setup and cleanup failed", {
        cause: error,
      });
    throw error;
  }
});
beforeEach(async () => resetDatabase(admin));
afterAll(async () => {
  if (setupCleanupAttempted) return;
  const results = await Promise.allSettled([runtime?.end(), admin?.end()]);
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) throw new AggregateError(errors, "Pool cleanup failed", { cause: errors[0] });
});

function inTenant<T>(tenant: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenant, () => withTransaction(runtime, fn));
}
function check(client: PoolClient, markdown: string): Promise<void> {
  return assertItemLinksExist(client, parseMarkdown(markdown), "markdown");
}
async function failureBody(client: PoolClient, markdown: string): Promise<unknown> {
  try {
    await check(client, markdown);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    return { status: error.status, code: error.code, message: error.message, details: error.details };
  }
  throw new Error("Expected a ValidationError");
}
async function counts(client: PoolClient): Promise<{ relations: number; docs: number; updates: number }> {
  const { rows } = await client.query<{ relations: number; docs: number; updates: number }>(
    `SELECT (SELECT count(*)::int FROM item_relations) AS relations,
            (SELECT count(*)::int FROM docs) AS docs,
            (SELECT count(*)::int FROM doc_updates) AS updates`,
  );
  const row = rows[0];
  if (!row) throw new Error("Missing counts");
  return row;
}
describe("assertItemLinksExist", () => {
  it("accepts local links and refuses missing, foreign, deleted and malformed links identically without writes", async () => {
    const tenantA = await createTestTenant(admin);
    const tenantB = await createTestTenant(admin);
    const local = await inTenant(tenantA, async (client) => {
      const db = await createDatabase(client, { name: "Local" });
      const own = await insertItem(client, { databaseId: db.id, properties: {} });
      const deleted = await insertItem(client, { databaseId: db.id, properties: {} });
      await softDeleteItem(client, db.id, deleted.id);
      return { own: own.id, deleted: deleted.id };
    });
    const foreign = await inTenant(tenantB, async (client) => {
      const db = await createDatabase(client, { name: "Foreign" });
      return (await insertItem(client, { databaseId: db.id, properties: {} })).id;
    });
    await inTenant(tenantB, (client) => check(client, `[Own](semprec://items/${foreign})`));
    await inTenant(tenantA, async (client) => {
      const before = await counts(client);
      await check(client, `[Standup](semprec://items/${local.own}) [Again](semprec://items/${local.own})`);
      await check(client, "plain [web](https://example.com) text");
      const missing = await failureBody(client, `[X](semprec://items/${randomUUID()})`);
      expect(missing).toMatchObject({
        status: 400,
        code: "validation_failed",
        details: { issues: [{ path: "markdown" }] },
      });
      for (const target of [foreign, local.deleted, "not-a-uuid"]) {
        expect(await failureBody(client, `[X](semprec://items/${target})`)).toEqual(missing);
      }
      expect(await failureBody(client, `[Own](semprec://items/${local.own}) [X](semprec://items/${foreign})`)).toEqual(
        missing,
      );
      expect(await counts(client)).toEqual(before);
    });
  });
});
