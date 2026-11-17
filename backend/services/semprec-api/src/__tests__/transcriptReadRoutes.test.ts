import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createChokePoint,
  createItemWithClient,
  createRelationWithClient,
  createUser,
  ensureItemAutomation,
  getDatabaseByModuleId,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  proposeSpeakerMappings,
  recordItemAutomationFailure,
  seedSystem,
  TRANSCRIPTION_OWNER_PROCESS,
  withTransaction,
  writeComputed,
} from "@semprec/data";
import { createDispatcher } from "../app.js";

const password = "transcript-http-password";
let admin: Pool;
let runtime: Pool;
let root: string;
let server: Server | undefined;
let baseUrl: string;
let tenantA: string;
let tenantB: string;
let authA: string;
let authB: string;

async function session(tenantId: string): Promise<string> {
  const email = `${randomUUID()}@example.com`;
  await createUser(admin, { tenantId, email, passwordHash: await hashPassword(password) });
  const { token } = await login(admin, { email, password, platform: "ios", ip: "127.0.0.1" });
  return `Bearer ${token}`;
}

function get(auth: string, id: string) {
  return fetch(`${baseUrl}/api/transcripts/${id}`, { headers: { Authorization: auth } });
}

describe("transcript detail through the dispatcher", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("check transcript HTTP role", () =>
      runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    root = await mkdtemp(join(tmpdir(), "semprec-transcript-http-"));
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenantA = await createTestTenant(admin);
    tenantB = await createTestTenant(admin);
    for (const tenant of [tenantA, tenantB]) await runInTenant(tenant, () => seedSystem(runtime));
    authA = await session(tenantA);
    authB = await session(tenantB);
    const dispatch = await createDispatcher(runtime, {
      passwordResetMailer: { async sendPasswordResetEmail() {} },
      appBaseUrl: "https://app.example.test",
      setupToken: "transcript-test-setup-token",
      moduleRegistry: await loadFullModuleRegistry(),
      blobStorage: new LocalFsBlobStorageWriter(root),
      maxFileSizeBytes: 1024,
    });
    const currentServer = createServer(dispatch);
    server = currentServer;
    await new Promise<void>((resolve) => currentServer.listen(0, "127.0.0.1", resolve));
    const address = currentServer.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    const currentServer = server;
    server = undefined;
    if (currentServer)
      await new Promise<void>((resolve, reject) => currentServer.close((error) => (error ? reject(error) : resolve())));
  });
  afterAll(async () => {
    const failures: unknown[] = [];
    try {
      await runtime?.end();
    } catch (error) {
      failures.push(error);
    }
    try {
      await admin?.end();
    } catch (error) {
      failures.push(error);
    }
    try {
      if (root) await rm(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Fixture cleanup failed");
  });

  it("returns the owner's captured segments and hides foreign and trashed transcripts", async () => {
    const fixture = await runInTenant(tenantA, () =>
      withTransaction(runtime, async (client) => {
        const database = await getDatabaseByModuleId(client, "transcripts");
        if (!database) throw new Error("Missing Transcripts database");
        const item = await createItemWithClient(
          client,
          {
            databaseId: database.id,
            properties: { name: "A recording", date: "2026-01-01T10:00:00.000Z" },
          },
          { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
        );
        await writeComputed(client, database.id, item.id, "segments", [
          { speaker: "SPEAKER_00", text: "First segment", startsAt: 0, endsAt: 1 },
          { speaker: "SPEAKER_01", text: "Second segment", startsAt: 1, endsAt: 2 },
        ]);
        await ensureItemAutomation(client, item.id);
        if (
          !(await recordItemAutomationFailure(
            client,
            item.id,
            "PRIVATE_PROVIDER_DIAGNOSTIC_1576",
            "error",
            "providerFailed",
          ))
        )
          throw new Error("Missing automation row");
        return { databaseId: database.id, itemId: item.id };
      }),
    );
    const owner = await get(authA, fixture.itemId);
    expect(owner.status).toBe(200);
    const ownerText = await owner.text();
    expect(ownerText).not.toContain("PRIVATE_PROVIDER_DIAGNOSTIC_1576");
    const ownerBody: unknown = JSON.parse(ownerText);
    expect(ownerBody).toMatchObject({
      id: fixture.itemId,
      displayName: "A recording",
      speakerCount: 2,
      speakers: [
        { speaker: "SPEAKER_00", ordinal: 1 },
        { speaker: "SPEAKER_01", ordinal: 2 },
      ],
      segments: [
        { index: 0, text: "First segment" },
        { index: 1, text: "Second segment" },
      ],
      meetingNotes: null,
      automation: { status: "error", errorCode: "providerFailed" },
      openQuestions: { count: 0, first: null },
    });
    const foreign = await get(authB, fixture.itemId);
    const random = await get(authB, randomUUID());
    expect(foreign.status).toBe(404);
    expect(random.status).toBe(404);
    const foreignBody = await foreign.text();
    expect(await random.text()).toBe(foreignBody);
    await runInTenant(tenantA, () => createChokePoint(runtime).softDeleteItem(fixture.databaseId, fixture.itemId));
    const trashed = await get(authA, fixture.itemId);
    expect(trashed.status).toBe(404);
    expect(await trashed.text()).toBe(foreignBody);
    expect((await get(authA, "bad-id")).status).toBe(400);
  });

  it("exposes speaker questions and confirms a production mapping through HTTP", async () => {
    const fixture = await runInTenant(tenantA, () =>
      withTransaction(runtime, async (client) => {
        const transcripts = await getDatabaseByModuleId(client, "transcripts");
        const events = await getDatabaseByModuleId(client, "events");
        const people = await getDatabaseByModuleId(client, "people");
        const proposals = await getDatabaseByModuleId(client, "processingProposals");
        if (!transcripts || !events || !people || !proposals) throw new Error("Missing transcript fixture databases");
        const transcript = await createItemWithClient(client, {
          databaseId: transcripts.id,
          properties: { name: "Meeting" },
        });
        await writeComputed(client, transcripts.id, transcript.id, "segments", [
          { speaker: "SPEAKER_00", text: "We discussed this together at our meeting.", startsAt: 0, endsAt: 1 },
          { speaker: "SPEAKER_01", text: "Another voice contributes to the same discussion.", startsAt: 1, endsAt: 2 },
        ]);
        const event = await createItemWithClient(client, {
          databaseId: events.id,
          properties: { name: "Event", date: "2026-10-16" },
        });
        const person = await createItemWithClient(client, { databaseId: people.id, properties: { name: "Alice" } });
        const properties = await client.query<{ id: string; database_id: string; key: string }>(
          "SELECT id, database_id, key FROM properties WHERE (database_id = $1 AND key = 'event') OR (database_id = $2 AND key = 'people')",
          [transcripts.id, events.id],
        );
        const eventProperty = properties.rows.find((row) => row.database_id === transcripts.id && row.key === "event");
        const peopleProperty = properties.rows.find((row) => row.database_id === events.id && row.key === "people");
        if (!eventProperty || !peopleProperty) throw new Error("Missing transcript fixture properties");
        await createRelationWithClient(client, {
          relationPropertyId: eventProperty.id,
          callerItemId: transcript.id,
          targetItemId: event.id,
        });
        await createRelationWithClient(client, {
          relationPropertyId: peopleProperty.id,
          callerItemId: event.id,
          targetItemId: person.id,
        });
        await proposeSpeakerMappings(client, {
          transcriptId: transcript.id,
          suggestions: [{ speaker: "SPEAKER_00", personId: person.id, reason: "The speaker is named." }],
        });
        const cards = await client.query<{ id: string }>(
          "SELECT id FROM items WHERE database_id = $1 AND properties ->> 'kind' = 'transcript' AND properties ->> 'status' = 'proposed'",
          [proposals.id],
        );
        if (cards.rows.length !== 1 || !cards.rows[0]) throw new Error("Missing speaker card");
        return { transcriptId: transcript.id, cardId: cards.rows[0].id, personId: person.id };
      }),
    );
    const detail = await get(authA, fixture.transcriptId);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      openQuestions: { count: 2, first: { proposalId: fixture.cardId, speaker: "SPEAKER_00", ordinal: 1 } },
    });
    const post = (auth: string, id: string) =>
      fetch(`${baseUrl}/api/proposals/${id}/confirm`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: "{}",
      });
    const foreign = await post(authB, fixture.cardId);
    const random = await post(authB, randomUUID());
    expect(foreign.status).toBe(404);
    expect(random.status).toBe(404);
    expect(await foreign.text()).toBe(await random.text());
    const confirmed = await post(authA, fixture.cardId);
    expect(confirmed.status).toBe(200);
    const after = await get(authA, fixture.transcriptId);
    expect(after.status).toBe(200);
    expect(await after.json()).toMatchObject({
      openQuestions: { count: 1, first: { speaker: "SPEAKER_01", ordinal: 2 } },
      speakers: [
        { speaker: "SPEAKER_00", label: "Alice", personId: fixture.personId },
        { speaker: "SPEAKER_01", personId: null },
      ],
    });
  });
});
