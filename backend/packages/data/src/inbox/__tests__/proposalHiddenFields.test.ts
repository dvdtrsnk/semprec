import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import type { DatabaseRow } from "../../types.js";
import { assertCardIsNotStdioMcpServer, normalizeEnvelopeForWrite } from "../proposalHiddenFields.js";
import type { ProposalEnvelope } from "../proposalEnvelope.js";

// Issue #1934: the envelope a confirm writes, read from the seeded databases the way confirm reads them.

let pool: Pool;
let databases: Record<string, DatabaseRow>;

const MODULES = ["tasks", "events", "mcpServers"] as const;
const TIMES = { timeFrom: "09:00", timeTo: "10:00" };

beforeEach(async () => {
  pool ??= getTestPool();
  await resetDatabase(pool);
  await seedSystem(pool, createViewTypeRegistry());
  databases = {};
  for (const moduleId of MODULES) {
    const database = await withTransaction(pool, (client) => getDatabaseByModuleId(client, moduleId));
    if (database) databases[moduleId] = database;
  }
});

afterAll(async () => {
  await pool?.end();
});

function databaseOf(moduleId: (typeof MODULES)[number]): DatabaseRow {
  const database = databases[moduleId];
  if (!database) throw new Error(`Database '${moduleId}' was not seeded`);
  return database;
}

const envelopeFor = (moduleId: (typeof MODULES)[number], properties: Record<string, unknown>): ProposalEnvelope => ({
  entityKind: "database",
  target: databaseOf(moduleId).id,
  properties,
});

/** A card of `kind` whose user set `userOverrides`. */
const cardOf = (userOverrides: Record<string, unknown>) => ({
  id: randomUUID(),
  properties: { kind: "inbox", userOverrides },
});

describe("normalizeEnvelopeForWrite (issue #1934)", () => {
  it("drops the times of an all-day task and leaves the envelope it was given as it was", async () => {
    const envelope = envelopeFor("tasks", { name: "Call", date: "2026-12-01", ...TIMES });

    const written = await withTransaction(pool, (client) =>
      normalizeEnvelopeForWrite(client, cardOf({ primary: { allDay: true } }), envelope, databaseOf("tasks")),
    );

    expect(written.properties).toEqual({ name: "Call", date: "2026-12-01" });
    expect(envelope.properties).toEqual({ name: "Call", date: "2026-12-01", ...TIMES });
  });

  it("sets the times of an all-day event to null", async () => {
    const written = await withTransaction(pool, (client) =>
      normalizeEnvelopeForWrite(
        client,
        cardOf({ primary: { allDay: true } }),
        envelopeFor("events", { name: "Review", date: "2026-12-01", ...TIMES }),
        databaseOf("events"),
      ),
    );

    expect(written.properties).toEqual({ name: "Review", date: "2026-12-01", timeFrom: null, timeTo: null });
  });

  it("returns a card whose base kind no module declares an editor for as it is", async () => {
    const envelope = envelopeFor("tasks", { name: "Call", date: "2026-12-01", ...TIMES });

    const written = await withTransaction(pool, (client) =>
      normalizeEnvelopeForWrite(client, cardOf({ primary: { allDay: true } }), envelope, databaseOf("tasks"), {
        getEditorSchemas: async () => [],
      }),
    );

    expect(written).toBe(envelope);
  });

  it.each([
    ["a page-content envelope", { entityKind: "pageContent", target: randomUUID(), properties: { markdown: "x" } }],
    ["a relation envelope", { entityKind: "relation", target: randomUUID(), properties: { propertyKey: "event" } }],
  ] as const)("returns %s as it is", async (_label, envelope) => {
    const written = await withTransaction(pool, (client) =>
      normalizeEnvelopeForWrite(client, cardOf({ primary: { allDay: true } }), envelope, null),
    );

    expect(written).toBe(envelope);
  });

  it("normalizes the top-level properties and the primary step of a multi-step card and no other step", async () => {
    const primary = { name: "Call", date: "2026-12-01", ...TIMES };
    const envelope: ProposalEnvelope = {
      ...envelopeFor("tasks", primary),
      operations: [
        { ref: "task", op: "create", databaseKey: "tasks", role: "primary", properties: primary },
        {
          ref: "followup",
          op: "create",
          databaseKey: "tasks",
          role: "secondary",
          properties: { name: "Follow up", ...TIMES },
        },
      ],
    };

    const written = await withTransaction(pool, (client) =>
      normalizeEnvelopeForWrite(client, cardOf({ task: { allDay: true } }), envelope, databaseOf("tasks")),
    );

    const expected = { name: "Call", date: "2026-12-01" };
    expect(written.properties).toEqual(expected);
    expect(written.operations?.map((step) => step.properties)).toEqual([expected, { name: "Follow up", ...TIMES }]);
  });

  it("writes a remote MCP server as { transport, url }", async () => {
    const written = await withTransaction(pool, (client) =>
      normalizeEnvelopeForWrite(
        client,
        cardOf({}),
        envelopeFor("mcpServers", {
          name: "Remote tool",
          connectionConfig: { transport: "http", url: "https://mcp.example.com/mcp", command: "my-mcp-server" },
        }),
        databaseOf("mcpServers"),
      ),
    );

    expect(written.properties).toEqual({
      name: "Remote tool",
      connectionConfig: { transport: "http", url: "https://mcp.example.com/mcp" },
    });
  });
});

describe("assertCardIsNotStdioMcpServer (issue #1934)", () => {
  const stdio = { transport: "stdio", command: "my-mcp-server" };
  const check = (envelope: ProposalEnvelope) =>
    withTransaction(pool, (client) => assertCardIsNotStdioMcpServer(client, envelope));

  it("refuses a stdio MCP server card with a validation error on transport", async () => {
    await expect(
      check(envelopeFor("mcpServers", { name: "Local tool", connectionConfig: stdio })),
    ).rejects.toMatchObject({
      details: { field: "transport" },
    });
  });

  it("passes a remote MCP server card and a card that has no connection yet", async () => {
    await expect(
      check(
        envelopeFor("mcpServers", {
          name: "Remote tool",
          connectionConfig: { transport: "http", url: "https://mcp.example.com/mcp" },
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(check(envelopeFor("mcpServers", { name: "Bare tool" }))).resolves.toBeUndefined();
  });

  it("passes a stdio connection on another destination, which the envelope validation refuses as an unknown property", async () => {
    await expect(check(envelopeFor("tasks", { name: "Call", connectionConfig: stdio }))).resolves.toBeUndefined();
  });

  it("passes an envelope that is not a database one, whatever its properties hold", async () => {
    await expect(
      check({ entityKind: "pageContent", target: randomUUID(), properties: { connectionConfig: stdio } }),
    ).resolves.toBeUndefined();
  });

  it("passes a stdio connection on a database that does not exist", async () => {
    await expect(
      check({ entityKind: "database", target: randomUUID(), properties: { connectionConfig: stdio } }),
    ).resolves.toBeUndefined();
  });
});
