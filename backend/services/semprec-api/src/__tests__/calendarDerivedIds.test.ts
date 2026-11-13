import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createChokePoint,
  createUser,
  createViewTypeRegistry,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  seedSystem,
  type ChokePoint,
  type PasswordResetMailer,
} from "@semprec/data";
import { getTestPool, resetDatabase, tenantForNextTestUser } from "@semprec/data/testSupport";
import { createDispatcher } from "../app.js";

const PASSWORD = "s3cret-password";
const noopMailer: PasswordResetMailer = {
  async sendPasswordResetEmail() {},
};
const moduleRegistry = await loadFullModuleRegistry();

const errorBody = z.object({ error: z.object({ code: z.string(), details: z.record(z.string(), z.unknown()) }) });

let pool: Pool;
let chokePoint: ChokePoint;

describe("derived calendar timeline ids on the item routes (issues #1800, #1804 and #1806)", () => {
  let server: Server;
  let baseUrl: string;
  let headers: Record<string, string>;
  let peopleId: string;
  let personId: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    const user = await createUser(pool, {
      tenantId: await tenantForNextTestUser(pool),
      email: `${randomUUID()}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
    });
    const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
    headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const people = (await chokePoint.listDatabases()).find((database) => database.ownerModuleId === "people");
    if (!people) throw new Error("People missing");
    peopleId = people.id;
    personId = (
      await chokePoint.createItem({
        databaseId: peopleId,
        properties: { name: "Jana Kovářová", birthday: "2000-10-16", birthdayYearKnown: false },
      })
    ).id;

    const dispatch = await createDispatcher(pool, {
      passwordResetMailer: noopMailer,
      appBaseUrl: "http://localhost",
      setupToken: "unused-setup-token",
      moduleRegistry,
      blobStorage: new LocalFsBlobStorageWriter(join(tmpdir(), `semprec-test-blobs-${randomUUID()}`)),
      maxFileSizeBytes: 10 * 1024 * 1024,
    });
    server = createServer(dispatch);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    await pool?.end();
  });

  /** The stored person and every People row, to compare before and after a refused request. */
  async function snapshot() {
    const person = await chokePoint.getItem(peopleId, personId);
    const people = await chokePoint.listItems(peopleId, { limit: 50 });
    return { person, people: people.items.map((item) => [item.id, item.updatedAt]) };
  }

  const derivedIds = (): string[] => [`birthday:${personId}:2026`, "holiday:cz:2026-10-28", "sleep:2026-10-15"];

  it("refuses a PATCH of a derived id with 400 validation_failed on id and changes nothing", async () => {
    const before = await snapshot();
    for (const id of derivedIds()) {
      const response = await fetch(`${baseUrl}/api/items/${id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ properties: { name: "Changed" } }),
      });
      expect(response.status).toBe(400);
      expect(errorBody.parse(await response.json())).toEqual({
        error: { code: "validation_failed", details: { field: "id" } },
      });
    }
    expect(await snapshot()).toEqual(before);
  });

  it("refuses a DELETE of a derived id with 400 validation_failed on id and changes nothing", async () => {
    const before = await snapshot();
    for (const id of derivedIds()) {
      const response = await fetch(`${baseUrl}/api/items/${id}`, { method: "DELETE", headers });
      expect(response.status).toBe(400);
      expect(errorBody.parse(await response.json())).toEqual({
        error: { code: "validation_failed", details: { field: "id" } },
      });
    }
    expect(await snapshot()).toEqual(before);
  });

  it("refuses a relation write on a derived id with 400 validation_failed on id and changes nothing", async () => {
    const before = await snapshot();
    const edgesBefore = await chokePoint.listItemRelations(personId);
    for (const id of derivedIds()) {
      const put = await fetch(`${baseUrl}/api/items/${id}/relations/projects/${randomUUID()}`, {
        method: "PUT",
        headers,
      });
      expect(put.status).toBe(400);
      expect(errorBody.parse(await put.json())).toEqual({
        error: { code: "validation_failed", details: { field: "id" } },
      });
      const remove = await fetch(`${baseUrl}/api/items/${id}/relations/projects/${randomUUID()}`, {
        method: "DELETE",
        headers,
      });
      expect(remove.status).toBe(400);
      expect(errorBody.parse(await remove.json())).toEqual({
        error: { code: "validation_failed", details: { field: "id" } },
      });
    }
    expect(await snapshot()).toEqual(before);
    expect(await chokePoint.listItemRelations(personId)).toEqual(edgesBefore);
  });

  it("still patches the person the derived id names", async () => {
    const stored = await chokePoint.getItem(peopleId, personId);
    const response = await fetch(`${baseUrl}/api/items/${personId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ properties: { birthday: "2000-11-17" }, ifVersion: stored?.updatedAt }),
    });
    expect(response.status).toBe(200);
    expect((await chokePoint.getItem(peopleId, personId))?.properties.birthday).toBe("2000-11-17");
  });
});
