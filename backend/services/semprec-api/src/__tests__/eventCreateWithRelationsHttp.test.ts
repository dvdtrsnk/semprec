import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { getTenantZeroId, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createChokePoint,
  createUser,
  createViewTypeRegistry,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  seedSystem,
  type PasswordResetMailer,
} from "@semprec/data";
import { createDispatcher } from "../app.js";

const PASSWORD = "s3cret-password";
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-${randomUUID()}`);
const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();

const DESCRIPTION = "## Agenda\n- [ ] Confirm the budget";
/** An Event as the calendar creates it: no `type` among its values. */
const EVENT = {
  name: "Kickoff",
  date: "2026-11-20",
  timeFrom: "10:00",
  timeTo: "11:00",
  place: "Kancelář, Karlín",
  description: DESCRIPTION,
};

const itemBody = z.object({ id: z.string(), properties: z.record(z.string(), z.unknown()) }).passthrough();
const relationsBody = z.object({
  relations: z.array(z.object({ propertyKey: z.string(), targetItemId: z.string() }).passthrough()),
});
const errorBody = z.object({
  error: z.object({ code: z.string(), details: z.record(z.string(), z.unknown()) }).passthrough(),
});

let pool: Pool;

/**
 * `POST /api/databases/:id/items` for an Event with `relations`, through the real dispatcher: the request
 * a signed-in client sends to create an Event with its calendar, project and people in one write.
 */
describe("an Event created with its calendar and relations over HTTP (issue #1777)", () => {
  let server: Server;
  let baseUrl: string;
  let headers: Record<string, string>;
  let eventsId: string;
  let personalId: string;
  let workId: string;
  let familyId: string;
  let projectId: string;
  let peopleIds: [string, string, string];

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    const user = await createUser(pool, {
      email: `${randomUUID()}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
      tenantId: getTenantZeroId(),
      locale: "en",
    });
    // Seeded after the English-speaking user exists, so the calendars are named `Personal`, `Work` and `Family`.
    await seedSystem(pool, createViewTypeRegistry());
    const chokePoint = createChokePoint(pool);
    const databases = await chokePoint.listDatabases();
    const databaseId = (moduleId: string): string => {
      const database = databases.find((candidate) => candidate.ownerModuleId === moduleId);
      if (!database) throw new Error(`Missing ${moduleId}`);
      return database.id;
    };
    eventsId = databaseId("events");
    const calendars = (await chokePoint.listItems(databaseId("calendars"), { limit: 50 })).items;
    const calendarId = (name: string): string => {
      const calendar = calendars.find((candidate) => candidate.properties.name === name);
      if (!calendar) throw new Error(`Missing calendar ${name}`);
      return calendar.id;
    };
    personalId = calendarId("Personal");
    workId = calendarId("Work");
    familyId = calendarId("Family");

    const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
    headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    server = createServer(
      await createDispatcher(pool, {
        passwordResetMailer: noopMailer,
        appBaseUrl: "http://localhost",
        setupToken: "unused-setup-token",
        moduleRegistry,
        blobStorage: new LocalFsBlobStorageWriter(tmpBlobDir),
        maxFileSizeBytes: 10 * 1024 * 1024,
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;

    projectId = await named(databaseId("projects"), "Web for client");
    peopleIds = [
      await named(databaseId("people"), "Alice Novak"),
      await named(databaseId("people"), "Bob Dvorak"),
      await named(databaseId("people"), "Cyril Kral"),
    ];
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function rest(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { ...headers, ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  async function named(databaseId: string, name: string): Promise<string> {
    const created = await rest("POST", `/api/databases/${databaseId}/items`, { properties: { name } });
    expect(created.status).toBe(201);
    return itemBody.parse(created.body).id;
  }

  /** The live edges of an item from its own side, as `[property key, target id]` pairs in the read's order. */
  async function edgesOf(itemId: string): Promise<string[][]> {
    const listed = await rest("GET", `/api/items/${itemId}/relations`);
    expect(listed.status).toBe(200);
    return relationsBody.parse(listed.body).relations.map((entry) => [entry.propertyKey, entry.targetItemId]);
  }

  /** The Events of the tenant, the trashed ones included. */
  async function storedEventIds(): Promise<string[]> {
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1 ORDER BY id", [
      eventsId,
    ]);
    return rows.map((row) => row.id);
  }

  const relations = (calendarId: string) => [
    { propertyKey: "calendar", targetItemIds: [calendarId] },
    { propertyKey: "project", targetItemIds: [projectId] },
    { propertyKey: "people", targetItemIds: peopleIds },
  ];

  /** The five edges of the Event, in the order the relation list reads them: by property key, then target id. */
  const fiveEdges = (calendarId: string) => [
    ["calendar", calendarId],
    ...[...peopleIds].sort().map((personId) => ["people", personId]),
    ["project", projectId],
  ];

  it("creates the Event in Work with its project and three people, and replays it by Idempotency-Key", async () => {
    const key = { "Idempotency-Key": randomUUID() };
    const created = await rest(
      "POST",
      `/api/databases/${eventsId}/items`,
      { properties: EVENT, relations: relations(workId) },
      key,
    );
    expect(created.status).toBe(201);
    const event = itemBody.parse(created.body);
    expect(event.properties).toMatchObject(EVENT);
    expect(event.properties).not.toHaveProperty("type");
    expect(await edgesOf(event.id)).toEqual(fiveEdges(workId));
    expect(await edgesOf(personalId)).toEqual([]);

    const replayed = await rest(
      "POST",
      `/api/databases/${eventsId}/items`,
      { properties: { ...EVENT, description: "Rewritten" }, relations: relations(familyId) },
      key,
    );
    expect(replayed.status).toBe(201);
    const replayedEvent = itemBody.parse(replayed.body);
    expect(replayedEvent.id).toBe(event.id);
    expect(replayedEvent.properties.description).toBe(DESCRIPTION);
    expect(await edgesOf(event.id)).toEqual(fiveEdges(workId));
    expect(await edgesOf(familyId)).toEqual([]);
    expect(await storedEventIds()).toEqual([event.id]);
  });

  it("links the default calendar when the relations name a project and people but no calendar", async () => {
    const created = await rest("POST", `/api/databases/${eventsId}/items`, {
      properties: EVENT,
      relations: relations(workId).slice(1),
    });
    expect(created.status).toBe(201);
    const event = itemBody.parse(created.body);
    expect(await edgesOf(event.id)).toEqual(fiveEdges(personalId));
    expect(await edgesOf(workId)).toEqual([]);
  });

  it("stores nothing when one of the people the relations name does not exist", async () => {
    const refused = await rest("POST", `/api/databases/${eventsId}/items`, {
      properties: EVENT,
      relations: [
        { propertyKey: "calendar", targetItemIds: [workId] },
        { propertyKey: "project", targetItemIds: [projectId] },
        { propertyKey: "people", targetItemIds: [peopleIds[0], peopleIds[1], randomUUID()] },
      ],
    });
    expect(refused.status).toBe(400);
    expect(errorBody.parse(refused.body).error).toMatchObject({
      code: "validation_failed",
      details: { field: "targetItemId" },
    });
    expect(await storedEventIds()).toEqual([]);
    expect(await edgesOf(workId)).toEqual([]);
    expect(await edgesOf(projectId)).toEqual([]);
    expect(await edgesOf(peopleIds[0])).toEqual([]);
  });

  it("stores nothing when the Event's timeTo is no time", async () => {
    const refused = await rest("POST", `/api/databases/${eventsId}/items`, {
      properties: { ...EVENT, timeTo: "25:00" },
      relations: relations(workId),
    });
    expect(refused.status).toBe(400);
    expect(errorBody.parse(refused.body).error).toMatchObject({
      code: "validation_failed",
      details: { field: "timeTo" },
    });
    expect(await storedEventIds()).toEqual([]);
    expect(await edgesOf(workId)).toEqual([]);
  });
});
