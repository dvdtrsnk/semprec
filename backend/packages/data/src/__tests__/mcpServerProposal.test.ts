import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { createInboxItemWithClient } from "../inbox/inboxStore.js";
import { createSemprecTickAction } from "../inbox/inboxTickAction.js";
import { confirmProposalWithClient, reviseProposalWithClient } from "../inbox/proposalActions.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { getDecryptedCredential, hasCredential } from "../credentials/externalCredentialsStore.js";
import { MCP_CREDENTIAL_FIELD_NAMES } from "../mcp/mcpServerProposal.js";

let pool: Pool;
let viewTypeRegistry: ViewTypeRegistry;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

describe("MCP server database seed and proposal/confirm integration (issue #123)", () => {
  let inboxId: string;
  let journalId: string;
  let proposalsId: string;
  let mcpServersId: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    inboxId = await databaseIdFor("inbox");
    journalId = await databaseIdFor("journal");
    proposalsId = await databaseIdFor("processingProposals");
    mcpServersId = await databaseIdFor("mcpServers");
  });

  it("seeds the mcpServers database with a locked schema and the expected properties", async () => {
    const { rows } = await pool.query<{ schema_locked: boolean; system: boolean }>("SELECT schema_locked, system FROM databases WHERE id = $1", [mcpServersId]);
    expect(rows[0]).toEqual({ schema_locked: true, system: true });

    const { rows: props } = await pool.query<{ key: string; owner: string }>("SELECT key, owner FROM properties WHERE database_id = $1 ORDER BY key", [mcpServersId]);
    expect(props).toEqual(
      expect.arrayContaining([
        { key: "name", owner: "user" },
        { key: "connectionConfig", owner: "user" },
        { key: "active", owner: "user" },
        { key: "syncStatus", owner: "system" },
        { key: "lastSynced", owner: "system" },
      ]),
    );
  });

  /** Drives a `needsClarification` proposal into `proposed` targeting mcpServers, mirroring proposalActions.test.ts's revise-from-clarification path. */
  async function createMcpProposal(properties: Record<string, unknown>) {
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, { inboxDatabaseId: inboxId, journalDatabaseId: journalId, timezone: "Europe/Prague", date: "2026-08-28", time: "09:00", text: "connect a server" }),
    );
    const handler = createSemprecTickAction(pool, async () => {
      throw new Error("must not be called for an untyped item");
    });
    await handler({ inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: await databaseIdFor("inboxItemTypes"), processingProposalsDatabaseId: proposalsId }, { heartbeatId: "hb", projectItemId: "proj", itemId: item.id });

    const { rows } = await pool.query<{ id: string }>(
      `SELECT i.id FROM items i WHERE i.database_id = $1 AND i.properties->>'status' = 'needsClarification' ORDER BY i.updated_at DESC LIMIT 1`,
      [proposalsId],
    );
    const proposalId = rows[0].id;

    return withTransaction(pool, (client) =>
      reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposalId, {
        message: "Connect this MCP server",
        entityKind: "database",
        target: mcpServersId,
        properties,
      }),
    );
  }

  it("accepts a proposal with a valid stdio connectionConfig and no credential", async () => {
    const proposal = await createMcpProposal({ name: "Local tool", connectionConfig: { transport: "stdio", command: "my-mcp-server" } });
    expect(proposal.properties.status).toBe("proposed");
  });

  it("rejects a proposal whose connectionConfig has an unknown transport", async () => {
    await expect(createMcpProposal({ name: "Bad", connectionConfig: { transport: "carrier-pigeon" } })).rejects.toThrow(/Invalid MCP server connectionConfig/);
  });

  it("rejects a proposal whose connectionConfig is missing required stdio fields", async () => {
    await expect(createMcpProposal({ name: "Bad", connectionConfig: { transport: "stdio" } })).rejects.toThrow(/Invalid MCP server connectionConfig/);
  });

  it.each(MCP_CREDENTIAL_FIELD_NAMES)("rejects a proposal carrying a credential-shaped field '%s'", async (field) => {
    await expect(createMcpProposal({ name: "Sneaky", [field]: "shh" })).rejects.toThrow(/cannot carry credential field/);
  });

  it("confirm with a credential atomically stores the item and the encrypted credential", async () => {
    const proposal = await createMcpProposal({ name: "Remote tool", connectionConfig: { transport: "sse", url: "https://mcp.example.com/sse" } });

    const confirmed = await withTransaction(pool, (client) =>
      confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, { credentialType: "api_key", plaintext: "sk-super-secret" }),
    );

    expect(confirmed.properties.status).toBe("confirmed");
    const serverId = confirmed.properties.resultItemId as string;

    const server = await withTransaction(pool, (client) => itemsStore.getItemById(client, mcpServersId, serverId));
    expect(server!.properties).toEqual({ name: "Remote tool", connectionConfig: { transport: "sse", url: "https://mcp.example.com/sse" } });
    expect(JSON.stringify(server!.properties)).not.toContain("sk-super-secret");

    const stored = await withTransaction(pool, (client) => hasCredential(client, serverId));
    expect(stored).toBe(true);

    const decrypted = await withTransaction(pool, (client) => getDecryptedCredential(client, { itemId: serverId, actorType: "mcp_connection_manager", purpose: "test" }));
    expect(decrypted).toBe("sk-super-secret");
  });

  it("confirm without a credential succeeds and stores no credential", async () => {
    const proposal = await createMcpProposal({ name: "No-auth tool", connectionConfig: { transport: "stdio", command: "my-mcp-server" } });

    const confirmed = await withTransaction(pool, (client) => confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id));

    const serverId = confirmed.properties.resultItemId as string;
    const stored = await withTransaction(pool, (client) => hasCredential(client, serverId));
    expect(stored).toBe(false);
  });

  it("confirm refuses a credential supplied for a non-mcpServers target, and stores neither item field nor credential elsewhere", async () => {
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, { inboxDatabaseId: inboxId, journalDatabaseId: journalId, timezone: "Europe/Prague", date: "2026-08-28", time: "09:00", text: "no type" }),
    );
    const handler = createSemprecTickAction(pool, async () => {
      throw new Error("must not be called");
    });
    await handler({ inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: await databaseIdFor("inboxItemTypes"), processingProposalsDatabaseId: proposalsId }, { heartbeatId: "hb", projectItemId: "proj", itemId: item.id });
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM items WHERE database_id = $1 AND properties->>'status' = 'needsClarification' ORDER BY updated_at DESC LIMIT 1`,
      [proposalsId],
    );
    const tasksId = await databaseIdFor("tasks");
    const proposal = await withTransaction(pool, (client) =>
      reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, rows[0].id, {
        message: "File under Tasks",
        entityKind: "database",
        target: tasksId,
        properties: { name: "Buy milk" },
      }),
    );

    await expect(
      withTransaction(pool, (client) =>
        confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, proposal.id, { credentialType: "api_key", plaintext: "should-not-be-stored" }),
      ),
    ).rejects.toThrow(/A credential may only be supplied when confirming an MCP server proposal/);

    const { rows: taskRows } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [tasksId]);
    expect(taskRows[0].n).toBe(0);
  });
});

afterAll(async () => {
  await pool?.end();
});
