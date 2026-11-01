import { randomUUID } from "node:crypto";
import { runInTenant } from "@semprec/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTenantZeroId, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { allowLoopbackOutboundForTests, startHttpContractServer } from "../../testSupport/mcpContractServers.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { withTransaction } from "../../db/pool.js";
import * as itemsStore from "../../chokePoint/itemsStore.js";
import * as databasesStore from "../../chokePoint/databasesStore.js";
import { NotFoundError, ValidationError } from "../../errors.js";
import {
  getMcpToolRegistration,
  listMcpToolRegistrationsForServer,
  upsertMcpToolRegistration,
} from "../mcpToolRegistrationsStore.js";
import { syncMcpServerTools } from "../mcpSync.js";
import { listMcpToolGrantsForProject, reclassifyMcpTool } from "../mcpAgentPageGrants.js";
import { setMcpToolDisplayLabel } from "../mcpGrantsAdminStore.js";

let pool: Pool;
let serverId: string;
let registrationId: string;

async function listLabel(locale: string): Promise<string | undefined> {
  const rows = await withTransaction(pool, (client) => listMcpToolGrantsForProject(client, randomUUID(), locale));
  return rows.find((r) => r.mcpToolRegistrationId === registrationId)?.displayLabel;
}

async function storedLabel(): Promise<unknown> {
  return (await getMcpToolRegistration(pool, registrationId))?.displayLabel;
}

describe("mcp_tool_registrations.display_label (issue #1391)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    const database = await withTransaction(pool, (client) =>
      databasesStore.getDatabaseByModuleId(client, "mcpServers"),
    );
    if (!database) throw new Error("mcpServers database was not seeded");
    const server = await withTransaction(pool, (client) =>
      itemsStore.insertItem(client, { databaseId: database.id, properties: { name: "Server", active: true } }),
    );
    serverId = server.id;
    registrationId = (
      await upsertMcpToolRegistration(pool, { mcpServerItemId: serverId, toolName: "read_issues", toolSchema: {} })
    ).id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("returns the label for the requesting locale", async () => {
    await setMcpToolDisplayLabel(pool, registrationId, { cs: "Číst issues", en: "Read issues" });
    expect(await listLabel("cs")).toBe("Číst issues");
    expect(await listLabel("en")).toBe("Read issues");
  });

  it("falls back to the other locale, then to the tool name", async () => {
    expect(await listLabel("cs")).toBe("read_issues");
    await setMcpToolDisplayLabel(pool, registrationId, { en: "Read issues" });
    expect(await listLabel("cs")).toBe("Read issues");
    expect(await listLabel("en")).toBe("Read issues");
    await setMcpToolDisplayLabel(pool, registrationId, { cs: "Číst issues" });
    expect(await listLabel("en")).toBe("Číst issues");
  });

  it("treats an unknown user locale as English", async () => {
    await setMcpToolDisplayLabel(pool, registrationId, { cs: "Číst", en: "Read" });
    expect(await listLabel("de")).toBe("Read");
  });

  it("trims values and clears the label with null", async () => {
    const set = await setMcpToolDisplayLabel(pool, registrationId, { en: "  Read  " });
    expect(set.displayLabel).toEqual({ en: "Read" });
    const cleared = await setMcpToolDisplayLabel(pool, registrationId, null);
    expect(cleared.displayLabel).toBeNull();
    expect(await listLabel("en")).toBe("read_issues");
  });

  it.each([
    ["unknown key", { de: "x" }],
    ["empty string", { cs: "" }],
    ["whitespace only", { cs: "   " }],
    ["non-string", { cs: 5 }],
    ["over 120 characters", { cs: "x".repeat(121) }],
    ["no keys", {}],
    ["array", ["x"]],
    ["string", "x"],
  ])("rejects %s and changes nothing", async (_name, label) => {
    await setMcpToolDisplayLabel(pool, registrationId, { cs: "Původní" });
    await expect(setMcpToolDisplayLabel(pool, registrationId, label)).rejects.toBeInstanceOf(ValidationError);
    expect(await storedLabel()).toEqual({ cs: "Původní" });
  });

  it("accepts exactly 120 characters", async () => {
    await setMcpToolDisplayLabel(pool, registrationId, { cs: "x".repeat(120) });
    expect(await storedLabel()).toEqual({ cs: "x".repeat(120) });
  });

  it("does not expose an unknown label key or value in the validation error", async () => {
    await setMcpToolDisplayLabel(pool, registrationId, { en: "Original" });
    const key = "private-key-sentinel";
    const value = "private-value-sentinel";
    let caught: unknown;
    try {
      await setMcpToolDisplayLabel(pool, registrationId, { [key]: value });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    if (!(caught instanceof ValidationError)) throw new Error("Expected validation error");
    expect(caught.message).toContain("displayLabel");
    const exposed = `${caught.message} ${JSON.stringify(caught.details)}`;
    expect(exposed).not.toContain(key);
    expect(exposed).not.toContain(value);
    expect(await storedLabel()).toEqual({ en: "Original" });
  });

  it("throws NotFoundError for an unknown id", async () => {
    await expect(setMcpToolDisplayLabel(pool, randomUUID(), { cs: "x" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("reclassifyMcpTool accepts displayLabel alone and rejects an empty input", async () => {
    const result = await withTransaction(pool, (client) =>
      reclassifyMcpTool(client, { mcpToolRegistrationId: registrationId, displayLabel: { cs: "Štítek" } }),
    );
    expect(result.displayLabel).toEqual({ cs: "Štítek" });
    await expect(
      withTransaction(pool, (client) => reclassifyMcpTool(client, { mcpToolRegistrationId: registrationId })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("keeps the stored label when a sync upserts the registration again", async () => {
    await setMcpToolDisplayLabel(pool, registrationId, { cs: "Číst", en: "Read" });
    await upsertMcpToolRegistration(pool, {
      mcpServerItemId: serverId,
      toolName: "read_issues",
      toolSchema: { type: "object" },
      description: "changed",
    });
    expect(await storedLabel()).toEqual({ cs: "Číst", en: "Read" });
  });

  it("preserves the label across actual MCP discovery syncs", async () => {
    const restorePolicy = allowLoopbackOutboundForTests();
    try {
      const contract = await startHttpContractServer();
      try {
        const database = await withTransaction(pool, (client) =>
          databasesStore.getDatabaseByModuleId(client, "mcpServers"),
        );
        if (!database) throw new Error("Missing MCP server database");
        const server = await withTransaction(pool, (client) =>
          itemsStore.insertItem(client, {
            databaseId: database.id,
            properties: { name: "Sync server", connectionConfig: contract.connectionConfig },
          }),
        );
        const sync = () => runInTenant(getTenantZeroId(), () => syncMcpServerTools(pool, server.id));
        expect((await sync()).toolCount).toBe(1);
        const [first] = await listMcpToolRegistrationsForServer(pool, server.id);
        if (!first) throw new Error("Missing discovered registration");
        await setMcpToolDisplayLabel(pool, first.id, { en: "User label" });
        contract.setTools([{ name: "search_web", description: "Updated discovery", inputSchema: { type: "object" } }]);
        expect((await sync()).toolCount).toBe(1);
        const [after] = await listMcpToolRegistrationsForServer(pool, server.id);
        expect(after).toMatchObject({
          id: first.id,
          description: "Updated discovery",
          displayLabel: { en: "User label" },
        });
      } finally {
        await contract.stop();
      }
    } finally {
      restorePolicy();
    }
  });

  it("rejects a non-object label at the database", async () => {
    await expect(
      pool.query(`UPDATE mcp_tool_registrations SET display_label = '"x"'::jsonb WHERE id = $1`, [registrationId]),
    ).rejects.toThrow(/display_label_object/);
  });

  it("rejects malformed stored label objects at both registration and listing reads", async () => {
    // The database CHECK accepts objects; simulate historical malformed JSONB that the writer refuses.
    await pool.query("UPDATE mcp_tool_registrations SET display_label = $2::jsonb WHERE id = $1", [
      registrationId,
      JSON.stringify({ en: 42 }),
    ]);
    await expect(storedLabel()).rejects.toThrow("Invalid stored MCP tool display label");
    await expect(listLabel("en")).rejects.toThrow("Invalid stored MCP tool display label");
  });
});
