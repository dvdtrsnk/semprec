import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { withTransaction } from "../../db/pool.js";
import * as itemsStore from "../../chokePoint/itemsStore.js";
import * as databasesStore from "../../chokePoint/databasesStore.js";
import type { connectMcpServer as ConnectMcpServerFn, McpClientHandle } from "../mcpConnectionFactory.js";
import { syncMcpServerTools } from "../mcpSync.js";
import {
  listMcpToolRegistrationsForServer,
  upsertClassifiedMcpToolRegistration,
  upsertMcpToolRegistration,
  type McpToolRegistration,
} from "../mcpToolRegistrationsStore.js";
import { setMcpToolRequiresApproval, setMcpToolRiskClass } from "../mcpGrantsAdminStore.js";
import { reclassifyMcpTool } from "../mcpAgentPageGrants.js";

/** What the faked `tools/list` answers; `annotations` is `unknown` because a server may send anything there. */
interface FakeTool {
  name: string;
  description?: string;
  inputSchema: { type: "object" };
  annotations?: unknown;
}

/**
 * The sync's connection is replaced by a fake whose `tools/list` answers `fakeServer.tools`: the contract servers
 * cannot advertise annotations. Everything after the connection (validation, the transaction, the upsert and the
 * stores) is the real code against the real database. Hoisted because the `vi.mock` factory below runs first.
 */
const fakeServer = vi.hoisted(() => ({ tools: [] as FakeTool[] }));

vi.mock("../mcpConnectionFactory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mcpConnectionFactory.js")>();
  const connect = async (): Promise<McpClientHandle> => {
    // Only `listTools` is read by the sync; the fake is not a full SDK client.
    const client = { listTools: async () => ({ tools: fakeServer.tools }) } as unknown as McpClientHandle["client"];
    return { client, close: async () => {} };
  };
  return { ...actual, connectMcpServer: connect as typeof ConnectMcpServerFn };
});

let pool: Pool;
let serverId: string;

function tool(name: string, annotations?: unknown): FakeTool {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object" },
    ...(annotations === undefined ? {} : { annotations }),
  };
}

async function registration(name: string): Promise<McpToolRegistration> {
  const found = (await listMcpToolRegistrationsForServer(pool, serverId)).find((r) => r.toolName === name);
  if (!found) throw new Error(`No registration '${name}'`);
  return found;
}

async function classificationSource(id: string): Promise<string> {
  const { rows } = await pool.query<{ classification_source: string }>(
    "SELECT classification_source FROM mcp_tool_registrations WHERE id = $1",
    [id],
  );
  return rows[0]!.classification_source;
}

async function classificationOf(name: string): Promise<{ riskClass: string; requiresApproval: boolean }> {
  const { riskClass, requiresApproval } = await registration(name);
  return { riskClass, requiresApproval };
}

describe("MCP tool classification from annotations (issue gh-1979)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    const database = await withTransaction(pool, (client) =>
      databasesStore.getDatabaseByModuleId(client, "mcpServers"),
    );
    if (!database) throw new Error("mcpServers database was not seeded");
    const server = await withTransaction(pool, (client) =>
      itemsStore.insertItem(client, { databaseId: database.id, properties: { name: "Annotated server" } }),
    );
    serverId = server.id;
    fakeServer.tools = [];
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe("a sync that sees a new tool", () => {
    it("stores the class and approval the annotations give", async () => {
      fakeServer.tools = [
        tool("readOnly", { readOnlyHint: true }),
        tool("destructive", { destructiveHint: true }),
        tool("outbound", { destructiveHint: false, openWorldHint: true }),
        tool("write", { destructiveHint: false }),
        tool("none"),
      ];

      const result = await syncMcpServerTools(pool, serverId);

      expect(result.toolCount).toBe(5);
      expect(await classificationOf("readOnly")).toEqual({ riskClass: "read", requiresApproval: false });
      expect(await classificationOf("destructive")).toEqual({ riskClass: "destructive", requiresApproval: true });
      expect(await classificationOf("outbound")).toEqual({ riskClass: "outbound", requiresApproval: true });
      expect(await classificationOf("write")).toEqual({ riskClass: "write", requiresApproval: true });
      expect(await classificationOf("none")).toEqual({ riskClass: "unclassified", requiresApproval: true });
      for (const name of ["readOnly", "destructive", "outbound", "write", "none"]) {
        expect(await classificationSource((await registration(name)).id)).toBe("annotation");
      }
    });

    it("applies the MCP default of destructive to annotations that carry no hint", async () => {
      fakeServer.tools = [tool("titleOnly", { title: "Only a title" })];

      await syncMcpServerTools(pool, serverId);

      expect(await classificationOf("titleOnly")).toEqual({ riskClass: "destructive", requiresApproval: true });
    });

    it("ignores a hint that is not a boolean, and annotations that are not an object", async () => {
      fakeServer.tools = [
        tool("stringHint", { readOnlyHint: "true" }),
        tool("nullAnnotations", null),
        tool("arrayAnnotations", [{ readOnlyHint: true }]),
        tool("stringAnnotations", "readOnlyHint"),
      ];

      await syncMcpServerTools(pool, serverId);

      expect(await classificationOf("stringHint")).toEqual({ riskClass: "destructive", requiresApproval: true });
      expect(await classificationOf("nullAnnotations")).toEqual({ riskClass: "unclassified", requiresApproval: true });
      expect(await classificationOf("arrayAnnotations")).toEqual({ riskClass: "unclassified", requiresApproval: true });
      expect(await classificationOf("stringAnnotations")).toEqual({
        riskClass: "unclassified",
        requiresApproval: true,
      });
    });
  });

  describe("a re-sync of a registration whose source is annotation", () => {
    it("updates the classification when the server changes a hint", async () => {
      fakeServer.tools = [tool("changing", { readOnlyHint: true })];
      await syncMcpServerTools(pool, serverId);
      const first = await registration("changing");
      expect(await classificationOf("changing")).toEqual({ riskClass: "read", requiresApproval: false });

      fakeServer.tools = [tool("changing", { readOnlyHint: false, destructiveHint: false, openWorldHint: true })];
      await syncMcpServerTools(pool, serverId);

      expect((await registration("changing")).id).toBe(first.id);
      expect(await classificationOf("changing")).toEqual({ riskClass: "outbound", requiresApproval: true });
      expect(await classificationSource(first.id)).toBe("annotation");
    });

    it("returns to unclassified when the server stops advertising annotations", async () => {
      fakeServer.tools = [tool("losing", { readOnlyHint: true })];
      await syncMcpServerTools(pool, serverId);

      fakeServer.tools = [tool("losing")];
      await syncMcpServerTools(pool, serverId);

      expect(await classificationOf("losing")).toEqual({ riskClass: "unclassified", requiresApproval: true });
    });
  });

  describe("a re-sync of a registration whose source is manual", () => {
    it("keeps the risk class and the approval a person set, and still refreshes the snapshot", async () => {
      fakeServer.tools = [tool("chosen", { readOnlyHint: true }), tool("untouched", { readOnlyHint: true })];
      await syncMcpServerTools(pool, serverId);
      const chosen = await registration("chosen");
      await setMcpToolRiskClass(pool, chosen.id, "breaksLink");
      await setMcpToolRequiresApproval(pool, chosen.id, true);
      expect(await classificationSource(chosen.id)).toBe("manual");

      fakeServer.tools = [
        { ...tool("chosen", { destructiveHint: true }), description: "Refreshed" },
        tool("untouched", { destructiveHint: true }),
      ];
      await syncMcpServerTools(pool, serverId);

      const resynced = await registration("chosen");
      expect(resynced).toMatchObject({ riskClass: "breaksLink", requiresApproval: true, description: "Refreshed" });
      expect(await classificationSource(chosen.id)).toBe("manual");
      // The annotation row of the same sync is derived again, so the manual one is spared by its source, not by the sync.
      expect(await classificationOf("untouched")).toEqual({ riskClass: "destructive", requiresApproval: true });
    });

    it("becomes manual when only the approval is changed, and then keeps the derived risk class as well", async () => {
      fakeServer.tools = [tool("approvalOnly", { readOnlyHint: true })];
      await syncMcpServerTools(pool, serverId);
      const created = await registration("approvalOnly");
      await setMcpToolRequiresApproval(pool, created.id, true);
      expect(await classificationSource(created.id)).toBe("manual");

      fakeServer.tools = [tool("approvalOnly", { destructiveHint: true })];
      await syncMcpServerTools(pool, serverId);

      expect(await classificationOf("approvalOnly")).toEqual({ riskClass: "read", requiresApproval: true });
    });

    it("becomes manual when only the risk class is changed, and then keeps the derived approval as well", async () => {
      fakeServer.tools = [tool("classOnly", { readOnlyHint: true })];
      await syncMcpServerTools(pool, serverId);
      const created = await registration("classOnly");
      await setMcpToolRiskClass(pool, created.id, "write");
      expect(await classificationSource(created.id)).toBe("manual");

      fakeServer.tools = [tool("classOnly", { destructiveHint: true })];
      await syncMcpServerTools(pool, serverId);

      expect(await classificationOf("classOnly")).toEqual({ riskClass: "write", requiresApproval: false });
    });

    it("becomes manual through reclassifyMcpTool, the writer behind PATCH /api/mcp-tool-registrations/:id", async () => {
      fakeServer.tools = [tool("patched", { readOnlyHint: true })];
      await syncMcpServerTools(pool, serverId);
      const created = await registration("patched");

      await withTransaction(pool, (client) =>
        reclassifyMcpTool(client, {
          mcpToolRegistrationId: created.id,
          riskClass: "outbound",
          requiresApproval: false,
        }),
      );
      expect(await classificationSource(created.id)).toBe("manual");

      fakeServer.tools = [tool("patched", { destructiveHint: true })];
      await syncMcpServerTools(pool, serverId);

      expect(await classificationOf("patched")).toEqual({ riskClass: "outbound", requiresApproval: false });
    });

    it("does not become manual when only the display label is changed through reclassifyMcpTool", async () => {
      fakeServer.tools = [tool("labelled", { readOnlyHint: true })];
      await syncMcpServerTools(pool, serverId);
      const created = await registration("labelled");

      await withTransaction(pool, (client) =>
        reclassifyMcpTool(client, { mcpToolRegistrationId: created.id, displayLabel: { en: "Labelled" } }),
      );

      expect(await classificationSource(created.id)).toBe("annotation");
    });
  });

  describe("upsertClassifiedMcpToolRegistration", () => {
    it("stores the column defaults for a new row without a classification and leaves an annotation row alone", async () => {
      const created = await upsertClassifiedMcpToolRegistration(pool, {
        mcpServerItemId: serverId,
        toolName: "plain",
        toolSchema: {},
      });
      expect(created).toMatchObject({ riskClass: "unclassified", requiresApproval: true });
      expect(await classificationSource(created.id)).toBe("annotation");

      await upsertClassifiedMcpToolRegistration(pool, {
        mcpServerItemId: serverId,
        toolName: "plain",
        toolSchema: {},
        classification: { riskClass: "read", requiresApproval: false },
      });
      expect(await classificationOf("plain")).toEqual({ riskClass: "read", requiresApproval: false });

      const again = await upsertClassifiedMcpToolRegistration(pool, {
        mcpServerItemId: serverId,
        toolName: "plain",
        toolSchema: {},
      });
      expect(again).toMatchObject({ riskClass: "read", requiresApproval: false });
    });
  });

  // The function `@semprec/data` exports (and so every consumer, `agent-runtime` included, can call) has no path to the
  // two columns the sync owns while their source is `annotation`.
  describe("upsertMcpToolRegistration, the exported upsert", () => {
    // A caller that bypasses the type system, as an `any` or a spread of a wider object would.
    const withClassification = { classification: { riskClass: "read", requiresApproval: false } };

    it("does not write a classification into a new row, even when one is smuggled past the type", async () => {
      const created = await upsertMcpToolRegistration(pool, {
        mcpServerItemId: serverId,
        toolName: "smuggledNew",
        toolSchema: {},
        ...withClassification,
      });

      expect(created).toMatchObject({ riskClass: "unclassified", requiresApproval: true });
    });

    it("does not rewrite an annotation row's classification, even when one is smuggled past the type", async () => {
      fakeServer.tools = [tool("derived", { readOnlyHint: true })];
      await syncMcpServerTools(pool, serverId);
      expect(await classificationOf("derived")).toEqual({ riskClass: "read", requiresApproval: false });

      const again = await upsertMcpToolRegistration(pool, {
        mcpServerItemId: serverId,
        toolName: "derived",
        toolSchema: { type: "object", title: "refreshed" },
        classification: { riskClass: "destructive", requiresApproval: true },
      } as Parameters<typeof upsertMcpToolRegistration>[1]);

      expect(again).toMatchObject({ riskClass: "read", requiresApproval: false });
      expect(again.toolSchema).toEqual({ type: "object", title: "refreshed" });
      expect(await classificationSource(again.id)).toBe("annotation");
    });
  });

  it("the schema rejects a classification source other than annotation and manual", async () => {
    await upsertClassifiedMcpToolRegistration(pool, {
      mcpServerItemId: serverId,
      toolName: "derived",
      toolSchema: {},
      classification: { riskClass: "read", requiresApproval: false },
    });
    await expect(
      pool.query("UPDATE mcp_tool_registrations SET classification_source = 'system' WHERE tool_name = 'derived'"),
    ).rejects.toThrow(/mcp_tool_registrations_classification_source_check/);
  });
});
