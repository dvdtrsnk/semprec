import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { upsertMcpToolRegistration } from "../mcp/mcpToolRegistrationsStore.js";
import { recordMcpConnectionFailure, recordMcpConnectionSuccess } from "../mcp/mcpServerConnectionStateStore.js";
import {
  countEffectiveMcpGrants,
  listMcpToolGrantsForProject,
  reclassifyMcpTool,
  setProjectMcpGrantForAgentPage,
} from "../mcp/mcpAgentPageGrants.js";

let pool: Pool;
let mcpServersId: string;

async function createMcpServerItem(name: string, active: boolean) {
  return withTransaction(pool, (client) =>
    itemsStore.insertItem(client, { databaseId: mcpServersId, properties: { name, active } }),
  );
}

describe("listMcpToolGrantsForProject (issue #127)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    const viewTypeRegistry: ViewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    const database = await withTransaction(pool, (client) =>
      databasesStore.getDatabaseByModuleId(client, "mcpServers"),
    );
    if (!database) throw new Error("mcpServers database was not seeded");
    mcpServersId = database.id;
  });

  it("returns an active registration unchecked (granted: false) for a project with no grant row yet", async () => {
    const server = await createMcpServerItem("Search server", true);
    const registration = await upsertMcpToolRegistration(pool, {
      mcpServerItemId: server.id,
      toolName: "search_web",
      toolSchema: { type: "object" },
      description: "Search the web",
    });
    const projectItemId = randomUUID();

    const rows = await withTransaction(pool, (client) => listMcpToolGrantsForProject(client, projectItemId, "cs"));
    expect(rows).toEqual([
      {
        mcpToolRegistrationId: registration.id,
        toolName: "search_web",
        description: "Search the web",
        displayLabel: "search_web",
        requiresApproval: true,
        riskClass: "unclassified",
        mcpServerItemId: server.id,
        mcpServerName: "Search server",
        mcpServerOnline: true,
        granted: false,
        effective: false,
        server: { state: "connected", lastConnectedAt: null, lastErrorReason: null },
      },
    ]);
  });

  it("reflects a project's granted state once set", async () => {
    const server = await createMcpServerItem("Server", true);
    const registration = await upsertMcpToolRegistration(pool, {
      mcpServerItemId: server.id,
      toolName: "tool",
      toolSchema: {},
    });
    const projectItemId = randomUUID();

    await withTransaction(pool, (client) =>
      setProjectMcpGrantForAgentPage(client, { projectItemId, mcpToolRegistrationId: registration.id, granted: true }),
    );

    const rows = await withTransaction(pool, (client) => listMcpToolGrantsForProject(client, projectItemId, "cs"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.granted).toBe(true);
  });

  it("excludes an inactive registration", async () => {
    const server = await createMcpServerItem("Server", true);
    await upsertMcpToolRegistration(pool, {
      mcpServerItemId: server.id,
      toolName: "tool",
      toolSchema: {},
      active: false,
    });

    const rows = await withTransaction(pool, (client) => listMcpToolGrantsForProject(client, randomUUID(), "cs"));
    expect(rows).toEqual([]);
  });

  it("includes an active registration on an inactive (offline) server, flagged as such", async () => {
    const server = await createMcpServerItem("Offline server", false);
    const registration = await upsertMcpToolRegistration(pool, {
      mcpServerItemId: server.id,
      toolName: "tool",
      toolSchema: {},
    });

    const rows = await withTransaction(pool, (client) => listMcpToolGrantsForProject(client, randomUUID(), "cs"));
    expect(rows).toEqual([expect.objectContaining({ mcpToolRegistrationId: registration.id, mcpServerOnline: false })]);
  });

  it("lists tools from every server in the system, not just ones a caller might think 'belong' to the project", async () => {
    const serverA = await createMcpServerItem("A", true);
    const serverB = await createMcpServerItem("B", true);
    const toolA = await upsertMcpToolRegistration(pool, {
      mcpServerItemId: serverA.id,
      toolName: "tool_a",
      toolSchema: {},
    });
    const toolB = await upsertMcpToolRegistration(pool, {
      mcpServerItemId: serverB.id,
      toolName: "tool_b",
      toolSchema: {},
    });

    const rows = await withTransaction(pool, (client) => listMcpToolGrantsForProject(client, randomUUID(), "cs"));
    expect(rows.map((r) => r.mcpToolRegistrationId).sort()).toEqual([toolA.id, toolB.id].sort());
  });
});

describe("effective grants and server state (issue #1455)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    const database = await withTransaction(pool, (client) =>
      databasesStore.getDatabaseByModuleId(client, "mcpServers"),
    );
    if (!database) throw new Error("mcpServers database was not seeded");
    mcpServersId = database.id;
  });

  async function register(serverId: string, toolName: string, projectItemId: string, granted: boolean) {
    const registration = await upsertMcpToolRegistration(pool, { mcpServerItemId: serverId, toolName, toolSchema: {} });
    if (granted) {
      await withTransaction(pool, (client) =>
        setProjectMcpGrantForAgentPage(client, {
          projectItemId,
          mcpToolRegistrationId: registration.id,
          granted: true,
        }),
      );
    }
    return registration;
  }

  const list = (projectItemId: string) =>
    withTransaction(pool, (client) => listMcpToolGrantsForProject(client, projectItemId, "en"));

  it("counts three effective of five active registrations", async () => {
    const projectItemId = randomUUID();
    const active = await createMcpServerItem("Active", true);
    for (const [name, granted] of [
      ["a", true],
      ["b", true],
      ["c", true],
      ["d", false],
      ["e", false],
    ] as const) {
      await register(active.id, name, projectItemId, granted);
    }
    expect(countEffectiveMcpGrants(await list(projectItemId))).toEqual({ effective: 3, total: 5 });
  });

  it("marks a granted tool of an inactive server offline and not effective", async () => {
    const projectItemId = randomUUID();
    const inactive = await createMcpServerItem("Inactive", false);
    await register(inactive.id, "tool", projectItemId, true);
    const rows = await list(projectItemId);
    expect(rows[0]).toMatchObject({ granted: true, effective: false, server: { state: "offline" } });
    expect(countEffectiveMcpGrants(rows)).toEqual({ effective: 0, total: 1 });
  });

  it("keeps tools of an active server with a failed connection effective, and clears it on success", async () => {
    const projectItemId = randomUUID();
    const server = await createMcpServerItem("Server", true);
    await register(server.id, "tool", projectItemId, true);

    await recordMcpConnectionFailure(pool, server.id, "handshake_failed");
    let rows = await list(projectItemId);
    expect(rows[0]).toMatchObject({
      effective: true,
      server: { state: "offline", lastErrorReason: "handshake_failed", lastConnectedAt: null },
    });
    expect(countEffectiveMcpGrants(rows)).toEqual({ effective: 1, total: 1 });

    await recordMcpConnectionSuccess(pool, server.id);
    rows = await list(projectItemId);
    expect(rows[0]!.server.state).toBe("connected");
    expect(rows[0]!.server.lastErrorReason).toBeNull();
    expect(typeof rows[0]!.server.lastConnectedAt).toBe("string");
  });

  it("counts an empty listing as zero of zero", () => {
    expect(countEffectiveMcpGrants([])).toEqual({ effective: 0, total: 0 });
  });
});

describe("setProjectMcpGrantForAgentPage / reclassifyMcpTool (issue #127)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    const viewTypeRegistry: ViewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    const database = await withTransaction(pool, (client) =>
      databasesStore.getDatabaseByModuleId(client, "mcpServers"),
    );
    if (!database) throw new Error("mcpServers database was not seeded");
    mcpServersId = database.id;
  });

  it("round-trips a grant toggle for the exact project/tool pair", async () => {
    const server = await createMcpServerItem("Server", true);
    const registration = await upsertMcpToolRegistration(pool, {
      mcpServerItemId: server.id,
      toolName: "tool",
      toolSchema: {},
    });
    const projectItemId = randomUUID();

    const grant = await withTransaction(pool, (client) =>
      setProjectMcpGrantForAgentPage(client, { projectItemId, mcpToolRegistrationId: registration.id, granted: true }),
    );
    expect(grant.granted).toBe(true);

    const revoked = await withTransaction(pool, (client) =>
      setProjectMcpGrantForAgentPage(client, { projectItemId, mcpToolRegistrationId: registration.id, granted: false }),
    );
    expect(revoked.granted).toBe(false);
  });

  it("propagates NotFoundError when granting an unknown registration id", async () => {
    await expect(
      withTransaction(pool, (client) =>
        setProjectMcpGrantForAgentPage(client, {
          projectItemId: randomUUID(),
          mcpToolRegistrationId: randomUUID(),
          granted: true,
        }),
      ),
    ).rejects.toThrow(NotFoundError);
  });

  it("reclassifies riskClass and requiresApproval independently", async () => {
    const server = await createMcpServerItem("Server", true);
    const registration = await upsertMcpToolRegistration(pool, {
      mcpServerItemId: server.id,
      toolName: "tool",
      toolSchema: {},
    });

    const afterRisk = await withTransaction(pool, (client) =>
      reclassifyMcpTool(client, { mcpToolRegistrationId: registration.id, riskClass: "destructive" }),
    );
    expect(afterRisk.riskClass).toBe("destructive");
    expect(afterRisk.requiresApproval).toBe(true);

    const afterApproval = await withTransaction(pool, (client) =>
      reclassifyMcpTool(client, { mcpToolRegistrationId: registration.id, requiresApproval: false }),
    );
    expect(afterApproval.requiresApproval).toBe(false);
    expect(afterApproval.riskClass).toBe("destructive");
  });

  it("applies both fields when both are supplied", async () => {
    const server = await createMcpServerItem("Server", true);
    const registration = await upsertMcpToolRegistration(pool, {
      mcpServerItemId: server.id,
      toolName: "tool",
      toolSchema: {},
    });

    const result = await withTransaction(pool, (client) =>
      reclassifyMcpTool(client, { mcpToolRegistrationId: registration.id, riskClass: "high", requiresApproval: false }),
    );
    expect(result.riskClass).toBe("high");
    expect(result.requiresApproval).toBe(false);
  });

  it("rejects a call with neither field set", async () => {
    await expect(
      withTransaction(pool, (client) => reclassifyMcpTool(client, { mcpToolRegistrationId: randomUUID() })),
    ).rejects.toThrow(ValidationError);
  });

  it("propagates NotFoundError for an unknown registration id", async () => {
    await expect(
      withTransaction(pool, (client) =>
        reclassifyMcpTool(client, { mcpToolRegistrationId: randomUUID(), riskClass: "high" }),
      ),
    ).rejects.toThrow(NotFoundError);
  });

  afterAll(async () => {
    await pool?.end();
  });
});
