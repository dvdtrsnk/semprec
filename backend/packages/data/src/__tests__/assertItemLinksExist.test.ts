import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { parseMarkdown } from "@semprec/block-model";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createDatabase } from "../chokePoint/databasesStore.js";
import { insertItem, softDeleteItem } from "../chokePoint/itemsStore.js";
import { assertItemLinksExist } from "../docs/assertItemLinksExist.js";
import { ValidationError } from "../errors.js";

let pool: Pool;

beforeAll(() => {
  pool = getTestPool();
});

afterAll(async () => {
  await pool.end();
});

async function inRolledBackTransaction(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  let failure: { error: unknown } | null = null;
  try {
    await client.query("BEGIN");
    await fn(client);
  } catch (error) {
    failure = { error };
  }
  try {
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
  if (failure) throw failure.error;
}

async function scopeTo(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("RESET ROLE");
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
  await client.query("SET LOCAL ROLE semprec_data");
}

function check(client: PoolClient, markdown: string): Promise<void> {
  return assertItemLinksExist(client, parseMarkdown(markdown), "markdown");
}

async function failureBody(client: PoolClient, markdown: string): Promise<unknown> {
  try {
    await check(client, markdown);
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationError);
    const failure = err as ValidationError;
    return { status: failure.status, code: failure.code, message: failure.message, details: failure.details };
  }
  throw new Error("expected a ValidationError");
}

describe("assertItemLinksExist", () => {
  it("accepts a link to a live item of the tenant and a document without item links", async () => {
    await resetDatabase(pool);
    await inRolledBackTransaction(async (client) => {
      const db = await createDatabase(client, { name: "Events" });
      const event = await insertItem(client, { databaseId: db.id, properties: {} });
      await check(client, `[Standup](semprec://items/${event.id}) and [Standup again](semprec://items/${event.id})`);
      await check(client, "plain [web](https://example.com) text");
    });
  });

  it("answers an unknown id, a foreign tenant id, a deleted item and a malformed id with the same body", async () => {
    await resetDatabase(pool);
    await inRolledBackTransaction(async (client) => {
      await client.query("DROP INDEX IF EXISTS tenants_single_tenant_guard");
      const { rows } = await client.query<{ id: string }>("SELECT id FROM tenants");
      const tenantA = rows[0]?.id;
      if (!tenantA) throw new Error("no first tenant");
      const { rows: inserted } = await client.query<{ id: string }>(
        "INSERT INTO tenants (status) VALUES ('active') RETURNING id",
      );
      const tenantB = inserted[0]?.id;
      if (!tenantB) throw new Error("second tenant was not inserted");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
      const dbA = await createDatabase(client, { name: "A" });
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantB]);
      const dbB = await createDatabase(client, { name: "B" });
      const foreign = await insertItem(client, { databaseId: dbB.id, properties: {} });
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
      const own = await insertItem(client, { databaseId: dbA.id, properties: {} });
      const trashed = await insertItem(client, { databaseId: dbA.id, properties: {} });
      await softDeleteItem(client, dbA.id, trashed.id);

      await scopeTo(client, tenantA);
      await check(client, `[Own](semprec://items/${own.id})`);

      const unknown = await failureBody(client, "[X](semprec://items/11111111-1111-4111-8111-111111111111)");
      expect(unknown).toMatchObject({ status: 400, code: "validation_failed" });
      expect(unknown).toMatchObject({ details: { issues: [{ path: "markdown" }] } });
      expect(await failureBody(client, `[X](semprec://items/${foreign.id})`)).toEqual(unknown);
      expect(await failureBody(client, `[X](semprec://items/${trashed.id})`)).toEqual(unknown);
      expect(await failureBody(client, "[X](semprec://items/not-a-uuid)")).toEqual(unknown);
      // One bad link among good ones fails the whole body.
      expect(await failureBody(client, `[Own](semprec://items/${own.id}) [X](semprec://items/${foreign.id})`)).toEqual(
        unknown,
      );
    });
  });

  it("writes no relation edge", async () => {
    await resetDatabase(pool);
    await inRolledBackTransaction(async (client) => {
      const db = await createDatabase(client, { name: "Events" });
      const event = await insertItem(client, { databaseId: db.id, properties: {} });
      const before = await client.query("SELECT count(*)::int AS n FROM item_relations");
      await check(client, `[Standup](semprec://items/${event.id})`);
      const after = await client.query("SELECT count(*)::int AS n FROM item_relations");
      expect(after.rows[0]).toEqual(before.rows[0]);
    });
  });
});
