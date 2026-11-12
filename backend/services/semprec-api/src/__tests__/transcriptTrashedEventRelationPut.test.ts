import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { getTenantZeroId, getTestPool, inTenantZero, resetDatabase } from "@semprec/data/testSupport";
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
import { createDispatcher } from "../app.js";

const PASSWORD = "s3cret-password";
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-${randomUUID()}`);
const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();

/** An error body as REST sends it. */
const errorBody = z.object({ error: z.object({ code: z.string() }) });
/** An item body, as far as the trash state. */
const itemBody = z.object({ id: z.string(), deletedAt: z.string().nullable() });

let pool: Pool;
let chokePoint: ChokePoint;

describe("PUT of a transcript's Event edge while its Event is in the Trash (issue #1743)", () => {
  let server: Server;
  let baseUrl: string;
  let headers: Record<string, string>;
  let transcriptsId: string;
  let eventsId: string;

  async function databaseIdFor(moduleId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM databases WHERE owner_module_id = $1 AND system",
      [moduleId],
    );
    if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
    return rows[0].id;
  }

  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    transcriptsId = await databaseIdFor("transcripts");
    eventsId = await databaseIdFor("events");

    const user = await createUser(pool, {
      email: `${randomUUID()}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
      tenantId: getTenantZeroId(),
    });
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
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function createItem(databaseId: string, properties: Record<string, unknown>): Promise<string> {
    return (await inTenantZero(() => chokePoint.createItem({ databaseId, properties }))).id;
  }

  function putRelation(itemId: string, propertyKey: string, targetItemId: string): Promise<Response> {
    return fetch(`${baseUrl}/api/items/${itemId}/relations/${propertyKey}/${targetItemId}`, {
      method: "PUT",
      headers,
    });
  }

  /** The Events the transcript's `event` relation stores an edge to, an Event in the Trash included. */
  async function storedEventIds(transcriptId: string): Promise<string[]> {
    const { rows } = await pool.query<{ other: string }>(
      `SELECT CASE WHEN r.item_a = $1 THEN r.item_b ELSE r.item_a END AS other
       FROM item_relations r
       JOIN relation_definitions d ON d.id = r.relation_definition_id
       JOIN properties p ON p.id = d.property_id_a OR p.id = d.property_id_b
       WHERE p.database_id = $2 AND p.key = 'event' AND (r.item_a = $1 OR r.item_b = $1)
       ORDER BY other`,
      [transcriptId, transcriptsId],
    );
    return rows.map((row) => row.other);
  }

  it("answers 409 cardinality_violation from the transcript's side and from the Event's side, and leaves the stored edge", async () => {
    const transcriptId = await createItem(transcriptsId, { name: "Recording 1" });
    const trashedEventId = await createItem(eventsId, { name: "Client meeting", date: "2024-03-01" });
    const otherEventId = await createItem(eventsId, { name: "Follow-up meeting", date: "2024-03-02" });
    expect((await putRelation(transcriptId, "event", trashedEventId)).status).toBe(200);
    const trashed = await fetch(`${baseUrl}/api/items/${trashedEventId}`, { method: "DELETE", headers });
    expect(trashed.status).toBe(200);
    expect(itemBody.parse(await trashed.json()).deletedAt).not.toBeNull();

    const fromTranscript = await putRelation(transcriptId, "event", otherEventId);
    expect(fromTranscript.status).toBe(409);
    expect(errorBody.parse(await fromTranscript.json()).error.code).toBe("cardinality_violation");

    const fromEvent = await putRelation(otherEventId, "transcript", transcriptId);
    expect(fromEvent.status).toBe(409);
    expect(errorBody.parse(await fromEvent.json()).error.code).toBe("cardinality_violation");

    expect(await storedEventIds(transcriptId)).toEqual([trashedEventId]);
  });
});
