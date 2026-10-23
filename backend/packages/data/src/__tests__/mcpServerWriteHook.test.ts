import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createTenantZeroUser, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { requireSingleRow, withTransaction } from "../db/pool.js";
import { createUser } from "../auth/usersStore.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import {
  clearHooksForTests,
  registerItemCreateHook,
  registerItemUpdateHook,
  registerRelationEdgeWriteHook,
  runItemCreateHooks,
  runItemUpdateHooks,
  runRelationEdgeWriteHooks,
  type ItemCreateHookContext,
  type ItemUpdateHookContext,
  type RelationEdgeWriteHookContext,
} from "../chokePoint/hooks.js";
import { loadRelationEdgeContext } from "../chokePoint/relationEdgeContext.js";
import { createInboxItemWithClient } from "../inbox/inboxStore.js";
import { createSemprecTickAction } from "../inbox/inboxTickAction.js";
import { confirmProposalWithClient, reviseProposalWithClient } from "../inbox/proposalActions.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as mcpServerWriteHook from "../mcp/mcpServerWriteHook.js";
import * as mailMessageFlagSyncStore from "../mail/mailMessageFlagSyncStore.js";
import * as taskRecurrenceItemUpdateHook from "../tasks/taskRecurrenceItemUpdateHook.js";
import * as transcriptionSpeakerEdges from "../transcription/transcriptionSpeakerEdges.js";

let pool: Pool;
let mcpServersId: string;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

async function countItems(databaseId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM items WHERE database_id = $1",
    [databaseId],
  );
  return Number(rows[0]!.count);
}

const create = (databaseId: string, properties: Record<string, unknown>, idempotencyKey?: string) =>
  withTransaction(pool, (client) => createItemWithClient(client, { databaseId, properties, idempotencyKey }));

describe("MCP server write hook and the item-create hook registry (issue #1029)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    mcpServersId = await databaseIdFor("mcpServers");
  });

  afterEach(() => {
    // Restore every production registration `domainWriteHooks.ts` makes. Re-importing that
    // module would not re-run its registrations: it is cached after its first import.
    clearHooksForTests();
    registerProductionWriteHookDefaults();
  });

  afterAll(async () => {
    await pool?.end();
  });

  /** Mirrors the five registrations of `../domainWriteHooks.ts`. Reads each hook through its module namespace, so a test's scoped spy is what gets registered while it is installed. */
  function registerProductionWriteHookDefaults(): void {
    registerItemCreateHook(mcpServerWriteHook.mcpServerItemCreateHook);
    registerItemUpdateHook(mcpServerWriteHook.mcpServerItemUpdateHook);
    registerItemUpdateHook(mailMessageFlagSyncStore.mailMessageFlagsItemUpdateHook);
    registerItemUpdateHook(taskRecurrenceItemUpdateHook.taskRecurrenceItemUpdateHook);
    registerRelationEdgeWriteHook(transcriptionSpeakerEdges.transcriptSpeakerEdgeWriteHook);
  }

  it("restores all five production write hooks after a registry reset, each dispatched once when restored twice (issue #1261)", async () => {
    const createSpy = vi.spyOn(mcpServerWriteHook, "mcpServerItemCreateHook").mockResolvedValue();
    const mcpUpdateSpy = vi.spyOn(mcpServerWriteHook, "mcpServerItemUpdateHook").mockResolvedValue();
    const mailUpdateSpy = vi.spyOn(mailMessageFlagSyncStore, "mailMessageFlagsItemUpdateHook").mockResolvedValue();
    const recurrenceUpdateSpy = vi
      .spyOn(taskRecurrenceItemUpdateHook, "taskRecurrenceItemUpdateHook")
      .mockResolvedValue();
    const speakerEdgeSpy = vi.spyOn(transcriptionSpeakerEdges, "transcriptSpeakerEdgeWriteHook").mockResolvedValue();
    const spies = [createSpy, mcpUpdateSpy, mailUpdateSpy, recurrenceUpdateSpy, speakerEdgeSpy];
    try {
      clearHooksForTests();
      registerProductionWriteHookDefaults();
      registerProductionWriteHookDefaults();

      await withTransaction(pool, async (client) => {
        const database = await databasesStore.getDatabase(client, mcpServersId);
        if (!database) throw new Error("mcpServers database was not seeded");
        const item = await itemsStore.insertItem(client, { databaseId: mcpServersId, properties: { name: "S" } });
        const transcriptsId = await databaseIdFor("transcripts");
        const speakersProperty = await propertiesStore.getPropertyByKey(
          client,
          transcriptsId,
          transcriptionSpeakerEdges.TRANSCRIPT_SPEAKERS_PROPERTY_KEY,
        );
        if (!speakersProperty) throw new Error("Transcripts speakers property was not seeded");

        const createContext: ItemCreateHookContext = { client, database, item, properties: { name: "S" } };
        const updateContext: ItemUpdateHookContext = { client, database, item, propertiesPatch: { name: "T" } };
        const edgeContext: RelationEdgeWriteHookContext = {
          client,
          edgeContext: await loadRelationEdgeContext(client, speakersProperty.id),
          callerItemId: randomUUID(),
          targetItemId: randomUUID(),
        };

        await runItemCreateHooks(createContext);
        expect(createSpy).toHaveBeenCalledTimes(1);
        expect(createSpy).toHaveBeenCalledWith(createContext);

        await runItemUpdateHooks(updateContext);
        for (const updateSpy of [mcpUpdateSpy, mailUpdateSpy, recurrenceUpdateSpy]) {
          expect(updateSpy).toHaveBeenCalledTimes(1);
          expect(updateSpy).toHaveBeenCalledWith(updateContext);
        }

        await runRelationEdgeWriteHooks(edgeContext);
        expect(speakerEdgeSpy).toHaveBeenCalledTimes(1);
        expect(speakerEdgeSpy).toHaveBeenCalledWith(edgeContext);
        expect(createSpy).toHaveBeenCalledTimes(1);
      });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("refuses a non-baseline remote url on create and leaves no row", async () => {
    await expect(
      create(mcpServersId, { name: "S", connectionConfig: { transport: "http", url: "http://mcp.example.com/" } }),
    ).rejects.toMatchObject({ details: { field: "connectionConfig" } });
    expect(await countItems(mcpServersId)).toBe(0);
  });

  it("refuses a non-baseline remote url on update and keeps the stored config", async () => {
    const good = { transport: "http", url: "https://mcp.example.com/mcp" };
    const item = await create(mcpServersId, { name: "S", connectionConfig: good });
    await expect(
      withTransaction(pool, (client) =>
        updateItemWithClient(client, {
          databaseId: mcpServersId,
          itemId: item.id,
          propertiesPatch: { connectionConfig: { transport: "sse", url: "https://127.0.0.1/sse" } },
        }),
      ),
    ).rejects.toMatchObject({ details: { field: "connectionConfig" } });
    const stored = await withTransaction(pool, (client) => itemsStore.getItemById(client, mcpServersId, item.id));
    expect(stored!.properties.connectionConfig).toEqual(good);
  });

  async function createAdmin(): Promise<string> {
    const { rows } = await pool.query<{ id: string | null }>("SELECT app_sole_tenant() AS id");
    const tenantId = requireSingleRow(rows, "sole tenant").id;
    if (!tenantId) throw new Error("Expected a sole tenant");
    const user = await createUser(pool, {
      email: "admin@example.test",
      passwordHash: "unused",
      tenantId,
      role: "admin",
    });
    return user.id;
  }

  const STDIO = { transport: "stdio", command: "my-server" };

  it("accepts a stdio config from a human admin writer", async () => {
    const adminId = await createAdmin();
    const item = await withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        { databaseId: mcpServersId, properties: { name: "S", connectionConfig: STDIO } },
        { humanWriterUserId: adminId },
      ),
    );
    expect(item.properties.connectionConfig).toEqual(STDIO);
  });

  it("refuses a stdio config whose env name is forbidden, even from an admin writer, and leaves no row (issue #1033)", async () => {
    const adminId = await createAdmin();
    const forbidden = [
      { transport: "stdio", command: "my-server", env: { PATH: "/evil" } },
      { transport: "stdio", command: "my-server", env: { LD_PRELOAD: "/evil.so" } },
      { transport: "stdio", command: "my-server", env: { NODE_OPTIONS: "--x" } },
      { transport: "stdio", command: "my-server", credentialEnvVar: "PATH" },
    ];
    for (const connectionConfig of forbidden) {
      await expect(
        withTransaction(pool, (client) =>
          createItemWithClient(
            client,
            { databaseId: mcpServersId, properties: { name: "S", connectionConfig } },
            { humanWriterUserId: adminId },
          ),
        ),
      ).rejects.toMatchObject({ details: { field: "connectionConfig" } });
    }
    expect(await countItems(mcpServersId)).toBe(0);
  });

  it("refuses a stdio config with no human writer, or a non-admin one, and leaves no row", async () => {
    const member = await createTenantZeroUser(pool);
    await expect(create(mcpServersId, { name: "S", connectionConfig: STDIO })).rejects.toMatchObject({
      details: { field: "connectionConfig" },
    });
    await expect(
      withTransaction(pool, (client) =>
        createItemWithClient(
          client,
          { databaseId: mcpServersId, properties: { name: "S", connectionConfig: STDIO } },
          { humanWriterUserId: member.id },
        ),
      ),
    ).rejects.toMatchObject({ details: { field: "connectionConfig" } });
    expect(await countItems(mcpServersId)).toBe(0);
  });

  it("applies the stdio rule on update", async () => {
    const adminId = await createAdmin();
    const good = { transport: "http", url: "https://mcp.example.com/mcp" };
    const item = await create(mcpServersId, { name: "S", connectionConfig: good });
    const patch = (humanWriterUserId?: string) =>
      withTransaction(pool, (client) =>
        updateItemWithClient(
          client,
          { databaseId: mcpServersId, itemId: item.id, propertiesPatch: { connectionConfig: STDIO } },
          { humanWriterUserId },
        ),
      );
    await expect(patch()).rejects.toMatchObject({ details: { field: "connectionConfig" } });
    const stored = await withTransaction(pool, (client) => itemsStore.getItemById(client, mcpServersId, item.id));
    expect(stored!.properties.connectionConfig).toEqual(good);
    expect((await patch(adminId)).properties.connectionConfig).toEqual(STDIO);
  });

  it("does not touch mcpServers writes that omit connectionConfig", async () => {
    const seeded = await withTransaction(pool, (client) =>
      itemsStore.insertItem(client, {
        databaseId: mcpServersId,
        properties: { name: "Old", connectionConfig: { transport: "http", url: "http://127.0.0.1:9/" } },
      }),
    );
    const updated = await withTransaction(pool, (client) =>
      updateItemWithClient(client, {
        databaseId: mcpServersId,
        itemId: seeded.id,
        propertiesPatch: { name: "Renamed" },
      }),
    );
    expect(updated.properties.name).toBe("Renamed");
    expect((await create(mcpServersId, { name: "No config" })).properties.name).toBe("No config");
  });

  it("does not apply the URL rule to other databases", async () => {
    const database = await withTransaction(pool, async (client) => {
      const created = await databasesStore.createDatabase(client, { name: "Other" });
      await propertiesStore.createProperty(client, {
        databaseId: created.id,
        key: "connectionConfig",
        name: "Connection config",
        type: "json",
      });
      return created;
    });
    const item = await create(database.id, { connectionConfig: { transport: "http", url: "http://127.0.0.1/" } });
    expect(item.id).toBeDefined();
  });

  it("runs a registered create hook once per real insert and not on an idempotency-key replay", async () => {
    const seen: string[] = [];
    registerItemCreateHook(async ({ item, properties }) => {
      seen.push(item.id);
      expect(properties).toEqual({ name: "Hooked" });
    });
    const key = randomUUID();
    const first = await create(mcpServersId, { name: "Hooked" }, key);
    const replay = await create(mcpServersId, { name: "Hooked" }, key);
    expect(replay.id).toBe(first.id);
    expect(seen).toEqual([first.id]);
  });

  it("rolls the insert back when a create hook throws", async () => {
    registerItemCreateHook(async () => {
      throw new Error("hook refused");
    });
    await expect(create(mcpServersId, { name: "Doomed" })).rejects.toThrow("hook refused");
    expect(await countItems(mcpServersId)).toBe(0);
  });

  it("refuses to confirm a stored envelope whose url fails the baseline", async () => {
    const inboxId = await databaseIdFor("inbox");
    const journalId = await databaseIdFor("journal");
    const proposalsId = await databaseIdFor("processingProposals");
    const inboxItem = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
        date: "2026-08-28",
        time: "09:00",
        text: "connect a server",
      }),
    );
    await createSemprecTickAction(pool, async () => {
      throw new Error("must not be called for an untyped item");
    })(
      {
        inboxDatabaseId: inboxId,
        inboxItemTypesDatabaseId: await databaseIdFor("inboxItemTypes"),
        processingProposalsDatabaseId: proposalsId,
      },
      { heartbeatId: "hb", projectItemId: "proj", itemId: inboxItem.id },
    );
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM items WHERE database_id = $1 AND properties->>'status' = 'needsClarification' LIMIT 1`,
      [proposalsId],
    );
    const proposalId = rows[0]!.id;
    await withTransaction(pool, (client) =>
      reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposalId, {
        message: "Connect",
        entityKind: "database",
        target: mcpServersId,
        properties: { name: "S", connectionConfig: { transport: "http", url: "https://mcp.example.com/mcp" } },
      }),
    );
    // Simulate an envelope stored before the baseline existed.
    await pool.query(
      `UPDATE items SET properties = jsonb_set(properties, '{proposal,properties,connectionConfig,url}', '"http://127.0.0.1/mcp"') WHERE id = $1`,
      [proposalId],
    );

    await expect(
      withTransaction(pool, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposalId),
      ),
    ).rejects.toMatchObject({ details: { field: "connectionConfig" } });
    expect(await countItems(mcpServersId)).toBe(0);
  });

  it("refuses an admin confirming a stored stdio envelope", async () => {
    await createAdmin();
    const inboxId = await databaseIdFor("inbox");
    const journalId = await databaseIdFor("journal");
    const proposalsId = await databaseIdFor("processingProposals");
    const inboxItem = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        journalDatabaseId: journalId,
        timezone: "Europe/Prague",
        date: "2026-08-28",
        time: "09:00",
        text: "connect a server",
      }),
    );
    await createSemprecTickAction(pool, async () => {
      throw new Error("must not be called for an untyped item");
    })(
      {
        inboxDatabaseId: inboxId,
        inboxItemTypesDatabaseId: await databaseIdFor("inboxItemTypes"),
        processingProposalsDatabaseId: proposalsId,
      },
      { heartbeatId: "hb", projectItemId: "proj", itemId: inboxItem.id },
    );
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM items WHERE database_id = $1 AND properties->>'status' = 'needsClarification' LIMIT 1`,
      [proposalsId],
    );
    const proposalId = rows[0]!.id;
    await withTransaction(pool, (client) =>
      reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposalId, {
        message: "Connect",
        entityKind: "database",
        target: mcpServersId,
        properties: { name: "S", connectionConfig: { transport: "http", url: "https://mcp.example.com/mcp" } },
      }),
    );
    // Simulate an envelope stored before stdio proposals were banned.
    await pool.query(
      `UPDATE items SET properties = jsonb_set(properties, '{proposal,properties,connectionConfig}', $2::jsonb) WHERE id = $1`,
      [proposalId, JSON.stringify(STDIO)],
    );

    await expect(
      withTransaction(pool, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposalId),
      ),
    ).rejects.toMatchObject({ details: { field: "connectionConfig" } });
    expect(await countItems(mcpServersId)).toBe(0);
  });
});
