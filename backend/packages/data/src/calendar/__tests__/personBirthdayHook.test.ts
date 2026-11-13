import "../../domainWriteHooks.js";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runInTenant } from "@semprec/shared";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
let peopleId: string;

const USER = { writerKind: "user" } as const;
const INVALID_BIRTHDAY = { status: 400, code: "validation_failed", details: { field: "birthday" } };

/** Values that are no real calendar date `YYYY-MM-DD`: month 13, a day a month lacks, a year-less form, a 29 February of a common year, and the wrong types. */
const INVALID_VALUES: [string, unknown][] = [
  ["month 13", "2026-13-01"],
  ["30 February", "2026-02-30"],
  ["a year-less date", "--10-16"],
  ["29 February of a common year", "2001-02-29"],
  ["year 0000, which Postgres cannot cast", "0000-01-01"],
  ["29 February of year 0000", "0000-02-29"],
  ["a Czech date", "16.10.2000"],
  ["a date with a time", "2000-10-16T10:00:00Z"],
  ["a date without zero padding", "2000-1-6"],
  ["an empty string", ""],
  ["a number", 20001016],
  ["true", true],
];

describe("People birthday write rule (issue #1795)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, async () => {
      await seedSystem(pool);
      const people = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "people"));
      if (!people) throw new Error("People missing");
      peopleId = people.id;
    });
  });

  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  const inTenant = <T>(fn: (cp: ReturnType<typeof createChokePoint>) => Promise<T>): Promise<T> =>
    runInTenant(tenant, () => fn(createChokePoint(pool)));

  const createPerson = (properties: Record<string, unknown>) =>
    inTenant((cp) =>
      cp.createItem(
        { databaseId: peopleId, properties: { name: "Jana Kovářová", ...properties } },
        undefined,
        undefined,
        USER,
      ),
    );

  const readPerson = (id: string) => inTenant((cp) => cp.getItem(peopleId, id));

  const peopleCount = () => inTenant(async (cp) => (await cp.listItems(peopleId, { limit: 50 })).items.length);

  it("stores a birthday with an unknown year as given", async () => {
    const person = await createPerson({ birthday: "2000-10-16", birthdayYearKnown: false });
    expect((await readPerson(person.id))?.properties).toMatchObject({
      birthday: "2000-10-16",
      birthdayYearKnown: false,
    });
  });

  it("stores a birthday with a known year as given", async () => {
    const person = await createPerson({ birthday: "1987-03-04", birthdayYearKnown: true });
    expect((await readPerson(person.id))?.properties).toMatchObject({
      birthday: "1987-03-04",
      birthdayYearKnown: true,
    });
  });

  it("stores 29 February of a leap year, the placeholder year included", async () => {
    const created = await createPerson({ birthday: "2000-02-29", birthdayYearKnown: false });
    expect((await readPerson(created.id))?.properties.birthday).toBe("2000-02-29");
    const other = await createPerson({ name: "Petr" });
    await inTenant((cp) =>
      cp.updateItem(
        { databaseId: peopleId, itemId: other.id, propertiesPatch: { birthday: "2024-02-29" } },
        undefined,
        undefined,
        USER,
      ),
    );
    expect((await readPerson(other.id))?.properties.birthday).toBe("2024-02-29");
  });

  it.each(INVALID_VALUES)(
    "refuses %s on create with 400 validation_failed on birthday and stores nothing",
    async (_name, value) => {
      await expect(createPerson({ birthday: value })).rejects.toMatchObject(INVALID_BIRTHDAY);
      expect(await peopleCount()).toBe(0);
    },
  );

  it.each(INVALID_VALUES)(
    "refuses %s on update with 400 validation_failed on birthday and keeps the stored value",
    async (_name, value) => {
      const person = await createPerson({ birthday: "2000-10-16", birthdayYearKnown: false });
      await expect(
        inTenant((cp) =>
          cp.updateItem(
            { databaseId: peopleId, itemId: person.id, propertiesPatch: { birthday: value, name: "Changed" } },
            undefined,
            undefined,
            USER,
          ),
        ),
      ).rejects.toMatchObject(INVALID_BIRTHDAY);
      expect((await readPerson(person.id))?.properties).toMatchObject({
        name: "Jana Kovářová",
        birthday: "2000-10-16",
      });
    },
  );

  it("clears a stored birthday with null on update", async () => {
    const person = await createPerson({ birthday: "2000-10-16", birthdayYearKnown: false });
    await inTenant((cp) =>
      cp.updateItem(
        { databaseId: peopleId, itemId: person.id, propertiesPatch: { birthday: null } },
        undefined,
        undefined,
        USER,
      ),
    );
    expect((await readPerson(person.id))?.properties.birthday ?? null).toBeNull();
  });

  it("accepts a null birthday on create", async () => {
    const person = await createPerson({ birthday: null });
    expect((await readPerson(person.id))?.properties.birthday ?? null).toBeNull();
  });

  it("leaves a person without a birthday unaffected by create and update", async () => {
    const person = await createPerson({});
    expect((await readPerson(person.id))?.properties).toMatchObject({ name: "Jana Kovářová" });
    await inTenant((cp) =>
      cp.updateItem(
        { databaseId: peopleId, itemId: person.id, propertiesPatch: { name: "Jana Nováková" } },
        undefined,
        undefined,
        USER,
      ),
    );
    expect((await readPerson(person.id))?.properties).toMatchObject({ name: "Jana Nováková" });
  });

  it("lets a person be renamed while the stored birthday is unreadable", async () => {
    const person = await createPerson({ birthday: "2000-10-16" });
    // Raw SQL: the API refuses to store an unreadable birthday, and this is the state an older write could have left.
    await runInTenant(tenant, () =>
      withTransaction(pool, (client) =>
        client.query(`UPDATE items SET properties = properties || '{"birthday": "--10-16"}'::jsonb WHERE id = $1`, [
          person.id,
        ]),
      ),
    );
    await inTenant((cp) =>
      cp.updateItem(
        { databaseId: peopleId, itemId: person.id, propertiesPatch: { name: "Renamed" } },
        undefined,
        undefined,
        USER,
      ),
    );
    expect((await readPerson(person.id))?.properties).toMatchObject({ name: "Renamed", birthday: "--10-16" });
  });

  it("does not judge a property called birthday in another database", async () => {
    const other = await inTenant(async (cp) => {
      const database = await cp.createDatabase({ name: "Pets" });
      await cp.createProperty({ databaseId: database.id, key: "birthday", name: "Birthday", type: "text" });
      return database;
    });
    const pet = await inTenant((cp) =>
      cp.createItem({ databaseId: other.id, properties: { birthday: "spring" } }, undefined, undefined, USER),
    );
    expect((await inTenant((cp) => cp.getItem(other.id, pet.id)))?.properties.birthday).toBe("spring");
    await inTenant((cp) =>
      cp.updateItem(
        { databaseId: other.id, itemId: pet.id, propertiesPatch: { birthday: "--10-16" } },
        undefined,
        undefined,
        USER,
      ),
    );
    expect((await inTenant((cp) => cp.getItem(other.id, pet.id)))?.properties.birthday).toBe("--10-16");
  });

  it("sorts a People database query and a stored People view by birthday, people without one included", async () => {
    const jana = await createPerson({ name: "Jana", birthday: "2000-10-16", birthdayYearKnown: false });
    const petr = await createPerson({ name: "Petr", birthday: "1987-03-04", birthdayYearKnown: true });
    const leap = await createPerson({ name: "Lenka", birthday: "2000-02-29", birthdayYearKnown: false });
    const none = await createPerson({ name: "Karel" });

    const ids = (page: { items: { id: string }[] }) => page.items.map((item) => item.id);
    const queried = await inTenant((cp) =>
      cp.queryDatabaseItems(peopleId, { sort: [{ property: "birthday", direction: "asc" }] }),
    );
    expect(ids(queried).filter((id) => id !== none.id)).toEqual([petr.id, leap.id, jana.id]);
    expect(ids(queried)).toContain(none.id);

    const view = await inTenant((cp) =>
      cp.createView({
        databaseId: peopleId,
        type: "table",
        name: "By birthday",
        config: { sort: [{ property: "birthday", direction: "desc" }] },
      }),
    );
    const viewed = await inTenant((cp) => cp.queryView(view.id));
    expect(ids(viewed).filter((id) => id !== none.id)).toEqual([jana.id, leap.id, petr.id]);
    expect(ids(viewed)).toContain(none.id);
  });
});
