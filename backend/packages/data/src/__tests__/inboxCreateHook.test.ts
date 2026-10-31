import "../domainWriteHooks.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { CORE_TASK_NAMES } from "@semprec/queue";
import { bindToTenantZero, getTestPool, inTenantZero, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createComputedKeyRegistry } from "../chokePoint/computedKeyRegistry.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { SYSTEM_WRITER, type WriterIdentity } from "../chokePoint/writerKind.js";
import { withTransaction } from "../db/pool.js";
import { inboxItemCreateHook } from "../inbox/inboxCreateHook.js";
import { journalInboxRecomputeJobKey } from "../inbox/journalInboxCompute.js";
import { INBOX_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { seedSystem } from "../seed/seedSystem.js";
import { NotFoundError } from "../errors.js";

let pool: Pool;
let chokePoint: ChokePoint;
let inboxId: string;
let journalId: string;
let projectsId: string;

const VALID = { date: "2026-08-28", time: "09:00" };

const ON_BEHALF_OF_USER_ID = "00000000-0000-4000-8000-000000000003";
// An agent tool's write, as the application gateway builds it for an agent run.
const AGENT_TOOL: WriterIdentity = {
  writerKind: "agent",
  agentRunId: "00000000-0000-4000-8000-000000000001",
  agentProjectItemId: "00000000-0000-4000-8000-000000000002",
  onBehalfOfUserId: ON_BEHALF_OF_USER_ID,
};
// A /mcp client's write: the agent kind acting for a user, without an agent run.
const MCP_CLIENT: WriterIdentity = { writerKind: "agent", onBehalfOfUserId: ON_BEHALF_OF_USER_ID };

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

async function itemCount(databaseId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [
    databaseId,
  ]);
  if (!rows[0]) throw new Error("count query returned no row");
  return rows[0].n;
}

/** The Journal day items an Inbox item is linked to through its `journalDay` edges, one entry per edge. */
async function journalDayIdsOf(itemId: string): Promise<string[]> {
  return inTenantZero(() =>
    withTransaction(pool, async (client) => {
      const property = await propertiesStore.getPropertyByKey(client, inboxId, "journalDay");
      if (!property) throw new Error("Inbox database has no 'journalDay' property");
      const definition = await relationsStore.getRelationDefinitionByPropertyId(client, property.id);
      if (!definition) throw new Error("'journalDay' has no relation definition");
      const edges = await relationsStore.listRelationsForItem(client, definition.id, itemId);
      return edges.map((edge) => relationsStore.otherSide(edge, itemId));
    }),
  );
}

/** Keys of the pending Journal-day recompute jobs, read from graphile-worker's private job tables as `inboxTickRecompute.test.ts` does. */
async function pendingRecomputeJobKeys(): Promise<string[]> {
  const { rows } = await pool.query<{ key: string }>(
    `SELECT j.key
     FROM graphile_worker._private_jobs j
     JOIN graphile_worker._private_tasks t ON t.id = j.task_id
     WHERE t.identifier = $1`,
    [CORE_TASK_NAMES.JOURNAL_INBOX_RECOMPUTE],
  );
  return rows.map((row) => row.key).sort();
}

/** The hook's refusal: a 400 `validation_failed` that names the failing field. */
function refusalFor(field: "date" | "time") {
  return { status: 400, code: "validation_failed", details: { field } };
}

describe("Inbox create hook: every Inbox item has a capture date and time and its Journal day", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    const viewTypeRegistry = createViewTypeRegistry();
    const computedKeyRegistry = createComputedKeyRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry, computedKeyRegistry);
    chokePoint = bindToTenantZero(createChokePoint(pool, computedKeyRegistry, viewTypeRegistry));
    inboxId = await databaseIdFor("inbox");
    journalId = await databaseIdFor("journal");
    projectsId = await databaseIdFor("projects");
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("a generic create with a valid date and time is linked to the Journal day of that date and queues its recompute", async () => {
    const item = await chokePoint.createItem({ databaseId: inboxId, properties: { ...VALID, text: "Buy milk" } });

    const dayIds = await journalDayIdsOf(item.id);
    expect(dayIds).toHaveLength(1);
    const day = await chokePoint.getItem(journalId, dayIds[0]!);
    expect(day).toMatchObject({ databaseId: journalId, properties: { type: "day", period: "2026-08-28" } });
    expect(await pendingRecomputeJobKeys()).toEqual([journalInboxRecomputeJobKey(dayIds[0]!)]);
  });

  it.each([
    ["a missing date", { time: "09:00" }, "date"],
    ["a date that is not a calendar date", { date: "abc", time: "09:00" }, "date"],
    ["a week date that Luxon also parses", { date: "2026-W35", time: "09:00" }, "date"],
    ["an impossible date", { date: "2026-02-30", time: "09:00" }, "date"],
    ["a missing time", { date: "2026-08-28" }, "time"],
    ["a time past midnight", { date: "2026-08-28", time: "24:00" }, "time"],
    ["a time that is not a clock time", { date: "2026-08-28", time: "abc" }, "time"],
  ] as const)(
    "a create with %s is refused on %s and leaves neither an item nor a Journal day",
    async (_label, properties, field) => {
      await expect(chokePoint.createItem({ databaseId: inboxId, properties })).rejects.toMatchObject(refusalFor(field));

      expect(await itemCount(inboxId)).toBe(0);
      expect(await itemCount(journalId)).toBe(0);
    },
  );

  it("an idempotent replay of a create keeps one item and exactly one Journal day edge", async () => {
    const first = await chokePoint.createItem({
      databaseId: inboxId,
      properties: VALID,
      idempotencyKey: "inbox-create-hook-replay",
    });
    const replay = await chokePoint.createItem({
      databaseId: inboxId,
      properties: VALID,
      idempotencyKey: "inbox-create-hook-replay",
    });

    expect(replay.id).toBe(first.id);
    expect(await itemCount(inboxId)).toBe(1);
    expect(await journalDayIdsOf(first.id)).toHaveLength(1);
  });

  it.each([
    ["an agent tool", AGENT_TOOL],
    ["/mcp", MCP_CLIENT],
  ] as const)("a create through %s is linked to its Journal day and refused without a date", async (_label, writer) => {
    const item = await chokePoint.createItem({ databaseId: inboxId, properties: VALID }, undefined, undefined, writer);
    expect(await journalDayIdsOf(item.id)).toHaveLength(1);

    await expect(
      chokePoint.createItem({ databaseId: inboxId, properties: { time: "09:00" } }, undefined, undefined, writer),
    ).rejects.toMatchObject(refusalFor("date"));
    expect(await itemCount(inboxId)).toBe(1);
  });

  it("a create in another database is not checked for a date or time and creates no Journal day", async () => {
    const project = await chokePoint.createItem({ databaseId: projectsId, properties: {} });

    expect(project.databaseId).toBe(projectsId);
    expect(await itemCount(journalId)).toBe(0);
  });

  it("an Inbox write into a database with no 'journalDay' property is refused with NotFound", async () => {
    // A real Projects item, passed to the hook as an Inbox-owned database, so the lookup of
    // 'journalDay' on that database is the one that misses.
    const projectItem = await chokePoint.createItem({ databaseId: projectsId, properties: {} });

    await expect(
      inTenantZero(() =>
        withTransaction(pool, async (client) => {
          const projects = await databasesStore.getDatabase(client, projectsId);
          if (!projects) throw new Error("Projects database was not seeded");
          await inboxItemCreateHook({
            client,
            database: { ...projects, ownerModuleId: INBOX_MODULE_ID },
            item: projectItem,
            properties: VALID,
            writer: SYSTEM_WRITER,
          });
        }),
      ),
    ).rejects.toThrow(NotFoundError);
  });
});
