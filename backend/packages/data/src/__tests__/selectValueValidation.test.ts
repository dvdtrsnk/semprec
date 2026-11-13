import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { withTransaction } from "../db/pool.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { HEALTH_RECORDS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

const USER: WriterIdentity = { writerKind: "user" };
const AGENT: WriterIdentity = { writerKind: "agent" };
const WRITERS: Array<[string, WriterIdentity]> = [
  ["user", USER],
  ["agent", AGENT],
];

let adminPool: Pool;
let dataPool: Pool;
let tenantId: string;
let healthId: string;

function inTenant<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(dataPool, fn));
}

function choke() {
  return {
    create: (databaseId: string, properties: Record<string, unknown>, writer?: WriterIdentity) =>
      runInTenant(tenantId, () =>
        createChokePoint(dataPool).createItem({ databaseId, properties }, undefined, undefined, writer),
      ),
    patch: (
      databaseId: string,
      itemId: string,
      propertiesPatch: Record<string, unknown>,
      writer?: WriterIdentity,
      ifVersion?: string,
    ) =>
      runInTenant(tenantId, () =>
        createChokePoint(dataPool).updateItem(
          { databaseId, itemId, propertiesPatch, ifVersion },
          undefined,
          undefined,
          writer,
        ),
      ),
  };
}

async function storedProperties(databaseId: string, itemId: string): Promise<Record<string, unknown>> {
  return inTenant(async (client) => {
    const { rows } = await client.query<{ properties: Record<string, unknown> }>(
      "SELECT properties FROM items WHERE database_id = $1 AND id = $2",
      [databaseId, itemId],
    );
    const row = rows[0];
    if (!row) throw new Error(`Item ${itemId} is not stored`);
    return row.properties;
  });
}

async function itemCount(databaseId: string): Promise<number> {
  return inTenant(async (client) => {
    const { rows } = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM items WHERE database_id = $1",
      [databaseId],
    );
    return rows[0]?.count ?? 0;
  });
}

async function refusal(write: Promise<unknown>): Promise<unknown> {
  return write.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
}

async function expectUnknownOption(write: Promise<unknown>, field: string, option: string): Promise<void> {
  const error = await refusal(write);
  expect(error).toBeInstanceOf(ValidationError);
  expect(error).toMatchObject({ status: 400, code: "validation_failed", details: { field } });
  expect(error instanceof Error ? error.message : "").toContain(`'${option}'`);
}

async function expectValidationFailure(write: Promise<unknown>, field: string): Promise<void> {
  const error = await refusal(write);
  expect(error).toBeInstanceOf(ValidationError);
  expect(error).toMatchObject({ status: 400, code: "validation_failed", details: { field } });
}

/** An item of the Health records database, written by the system the way mail or transcription ingest writes. */
async function seedHealthRecord(properties: Record<string, unknown>) {
  return choke().create(healthId, { name: "Record", ...properties });
}

/** A custom database of the tenant: a title `name` and the given properties, so no catalog names its options. */
async function ownDatabase(
  properties: Array<{
    key: string;
    name: string;
    type: "select" | "multi_select" | "text";
    config?: Record<string, unknown>;
  }>,
): Promise<string> {
  const database = await runInTenant(tenantId, () =>
    createChokePoint(dataPool).createDatabaseWithProperties({ name: "Own database" }, "Name", properties),
  );
  return database.id;
}

beforeAll(async () => {
  adminPool = getTestPool();
  dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
  const role = await dataPool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
  );
  expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
});

beforeEach(async () => {
  await resetDatabase(adminPool);
  tenantId = await createTestTenant(adminPool);
  await runInTenant(tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
  const health = await inTenant((client) => databasesStore.getDatabaseByModuleId(client, HEALTH_RECORDS_MODULE_ID));
  if (!health) throw new Error("The tenant has no Health records database");
  healthId = health.id;
});

afterAll(async () => {
  await dataPool?.end();
  await adminPool?.end();
});

describe.each(WRITERS)("select values on item writes by the %s writer (issue gh-1802)", (_kind, writer) => {
  it("refuses a create with tags [neznamy], naming the unknown value, and stores nothing", async () => {
    await expectUnknownOption(
      choke().create(healthId, { name: "Record", tags: ["neznamy"] }, writer),
      "tags",
      "neznamy",
    );

    expect(await itemCount(healthId)).toBe(0);
  });

  it("accepts a create with tags [medication] and stores it", async () => {
    const created = await choke().create(healthId, { name: "Record", tags: ["medication"] }, writer);

    expect((await storedProperties(healthId, created.id)).tags).toEqual(["medication"]);
  });

  it("refuses a create when only one of several tags is unknown", async () => {
    await expectUnknownOption(
      choke().create(healthId, { name: "Record", tags: ["medication", "neznamy"] }, writer),
      "tags",
      "neznamy",
    );

    expect(await itemCount(healthId)).toBe(0);
  });

  it("refuses a patch to tags [neznamy] and keeps the stored item", async () => {
    const record = await seedHealthRecord({ tags: ["medication"] });
    const before = await storedProperties(healthId, record.id);

    await expectUnknownOption(choke().patch(healthId, record.id, { tags: ["neznamy"] }, writer), "tags", "neznamy");

    expect(await storedProperties(healthId, record.id)).toEqual(before);
  });

  it("accepts a patch to tags [medication]", async () => {
    const record = await seedHealthRecord({ tags: ["prevention"] });

    await choke().patch(healthId, record.id, { tags: ["medication"] }, writer);

    expect((await storedProperties(healthId, record.id)).tags).toEqual(["medication"]);
  });

  it("refuses a select with an unknown key on create", async () => {
    await expectUnknownOption(choke().create(healthId, { name: "Record", status: "ghost" }, writer), "status", "ghost");

    expect(await itemCount(healthId)).toBe(0);
  });

  it("accepts a select with a catalog key on create", async () => {
    const created = await choke().create(healthId, { name: "Record", status: "monitoring" }, writer);

    expect((await storedProperties(healthId, created.id)).status).toBe("monitoring");
  });

  it("refuses a select with an unknown key on update and keeps the stored item", async () => {
    const record = await seedHealthRecord({ status: "monitoring" });

    await expectUnknownOption(choke().patch(healthId, record.id, { status: "ghost" }, writer), "status", "ghost");

    expect((await storedProperties(healthId, record.id)).status).toBe("monitoring");
  });

  it("accepts a select with a catalog key on update", async () => {
    const record = await seedHealthRecord({ status: "monitoring" });

    await choke().patch(healthId, record.id, { status: "resolved" }, writer);

    expect((await storedProperties(healthId, record.id)).status).toBe("resolved");
  });

  it("clears a select and a multi_select with null", async () => {
    const record = await seedHealthRecord({ status: "monitoring", tags: ["medication"] });

    await choke().patch(healthId, record.id, { status: null, tags: null }, writer);

    expect(await storedProperties(healthId, record.id)).toMatchObject({ status: null, tags: null });
  });

  it("accepts null for a select and a multi_select on create", async () => {
    const created = await choke().create(healthId, { name: "Record", status: null, tags: null }, writer);

    expect(await storedProperties(healthId, created.id)).toMatchObject({ status: null, tags: null });
  });

  it("clears a multi_select with an empty array", async () => {
    const record = await seedHealthRecord({ tags: ["medication"] });

    await choke().patch(healthId, record.id, { tags: [] }, writer);

    expect((await storedProperties(healthId, record.id)).tags).toEqual([]);
  });

  it.each([
    ["a select holding a number", { status: 3 }, "status"],
    ["a select holding an array", { status: ["monitoring"] }, "status"],
    ["a multi_select holding a string", { tags: "medication" }, "tags"],
    ["a multi_select holding a non-string element", { tags: ["medication", 7] }, "tags"],
  ])("refuses %s on create and on update", async (_label, properties, field) => {
    const record = await seedHealthRecord({ tags: ["medication"] });
    const before = await storedProperties(healthId, record.id);

    await expectValidationFailure(choke().create(healthId, { name: "Other", ...properties }, writer), field);
    await expectValidationFailure(choke().patch(healthId, record.id, properties, writer), field);

    expect(await storedProperties(healthId, record.id)).toEqual(before);
    expect(await itemCount(healthId)).toBe(1);
  });

  describe("a value already stored", () => {
    it("accepts a patch that resends the unchanged unknown values of a whole record", async () => {
      const record = await seedHealthRecord({ tags: ["neznamy"], status: "ghost" });

      await choke().patch(healthId, record.id, { name: "Renamed", tags: ["neznamy"], status: "ghost" }, writer);

      expect(await storedProperties(healthId, record.id)).toMatchObject({
        name: "Renamed",
        tags: ["neznamy"],
        status: "ghost",
      });
    });

    it("accepts a patch of another key and leaves the stored unknown values alone", async () => {
      const record = await seedHealthRecord({ tags: ["neznamy"], status: "ghost" });

      await choke().patch(healthId, record.id, { name: "Renamed" }, writer);

      expect(await storedProperties(healthId, record.id)).toMatchObject({ tags: ["neznamy"], status: "ghost" });
    });

    it("refuses a multi_select that adds a catalog key to the stored unknown one", async () => {
      const record = await seedHealthRecord({ tags: ["neznamy"] });

      await expectUnknownOption(
        choke().patch(healthId, record.id, { tags: ["neznamy", "medication"] }, writer),
        "tags",
        "neznamy",
      );

      expect((await storedProperties(healthId, record.id)).tags).toEqual(["neznamy"]);
    });

    it("refuses a different unknown value for a select whose stored value is unknown", async () => {
      const record = await seedHealthRecord({ status: "ghost" });

      await expectUnknownOption(choke().patch(healthId, record.id, { status: "phantom" }, writer), "status", "phantom");

      expect((await storedProperties(healthId, record.id)).status).toBe("ghost");
    });

    it("accepts a catalog value and null in place of a stored unknown value", async () => {
      const record = await seedHealthRecord({ tags: ["neznamy"], status: "ghost" });

      await choke().patch(healthId, record.id, { tags: ["medication"], status: null }, writer);

      expect(await storedProperties(healthId, record.id)).toMatchObject({ tags: ["medication"], status: null });
    });

    it("refuses a create that sends an unknown value another item stores", async () => {
      // A create has no stored value to compare with, so even a value another item stores is refused.
      await seedHealthRecord({ tags: ["neznamy"] });

      await expectUnknownOption(
        choke().create(healthId, { name: "Second", tags: ["neznamy"] }, writer),
        "tags",
        "neznamy",
      );

      expect(await itemCount(healthId)).toBe(1);
    });
  });

  it("refuses an unknown value for a select whose property has no options", async () => {
    const databaseId = await ownDatabase([{ key: "choice", name: "Choice", type: "select" }]);

    await expectUnknownOption(
      choke().create(databaseId, { name: "Item", choice: "anything" }, writer),
      "choice",
      "anything",
    );
    const created = await choke().create(databaseId, { name: "Item", choice: null }, writer);

    expect((await storedProperties(databaseId, created.id)).choice).toBeNull();
  });

  it("stores the catalog default of a select the create omits", async () => {
    const databaseId = await ownDatabase([
      { key: "choice", name: "Choice", type: "select", config: { options: [{ key: "known" }], default: "known" } },
    ]);

    const created = await choke().create(databaseId, { name: "Item" }, writer);

    expect((await storedProperties(databaseId, created.id)).choice).toBe("known");
  });

  it("stores the string default of a multi_select the create omits, but still checks a value the caller sends", async () => {
    const databaseId = await ownDatabase([
      { key: "tags", name: "Tags", type: "multi_select", config: { options: [{ key: "one" }], default: "one" } },
    ]);

    const created = await choke().create(databaseId, { name: "Item" }, writer);

    expect((await storedProperties(databaseId, created.id)).tags).toBe("one");
    await expectUnknownOption(choke().create(databaseId, { name: "Item", tags: ["ghost"] }, writer), "tags", "ghost");
    const chosen = await choke().create(databaseId, { name: "Item", tags: ["one"] }, writer);
    expect((await storedProperties(databaseId, chosen.id)).tags).toEqual(["one"]);
  });

  it("leaves a database without select properties unaffected", async () => {
    const databaseId = await ownDatabase([{ key: "note", name: "Note", type: "text" }]);

    const created = await choke().create(databaseId, { name: "Item", note: "neznamy" }, writer);
    await choke().patch(databaseId, created.id, { note: "other" }, writer);

    expect((await storedProperties(databaseId, created.id)).note).toBe("other");
  });
});

describe("select values on item writes (issue gh-1802)", () => {
  it("does not check the system writer on create or update", async () => {
    const created = await choke().create(healthId, { name: "Record", tags: ["neznamy"], status: "ghost" });
    await choke().patch(healthId, created.id, { tags: ["other"], status: "phantom" });

    expect(await storedProperties(healthId, created.id)).toMatchObject({ tags: ["other"], status: "phantom" });
  });

  it("answers an update of a missing item with a select key like any other missing item", async () => {
    await expect(
      choke().patch(healthId, "00000000-0000-4000-8000-000000000000", { status: "monitoring" }, USER),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("answers an update of a select with a stale ifVersion with a conflict, not a catalog error", async () => {
    const record = await seedHealthRecord({ status: "monitoring" });
    await choke().patch(healthId, record.id, { name: "Renamed" });

    const error = await refusal(choke().patch(healthId, record.id, { status: "ghost" }, USER, record.updatedAt));

    expect(error).toBeInstanceOf(ConflictError);
    expect((await storedProperties(healthId, record.id)).status).toBe("monitoring");
  });

  it("raises a malformed option catalog as a server error, not as a validation failure", async () => {
    // A catalog the property write path refuses to store, so only a raw UPDATE produces it.
    await adminPool.query(
      "UPDATE properties SET config = '{\"options\": \"monitoring\"}'::jsonb WHERE database_id = $1 AND key = 'status'",
      [healthId],
    );

    const error = await refusal(choke().create(healthId, { name: "Record", status: "monitoring" }, USER));

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ValidationError);
    expect(error instanceof Error ? error.message : "").toBe("Malformed property config");
  });
});
