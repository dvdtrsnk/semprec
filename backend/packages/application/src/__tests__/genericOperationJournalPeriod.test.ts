import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createTenantZeroUser, getTestPool, inTenantZero, resetDatabase } from "@semprec/data/testSupport";
import {
  createAgentRun,
  createChokePoint,
  createViewTypeRegistry,
  getDatabaseByModuleId,
  seedSystem,
  withTransaction,
  type AgentDatabaseAccess,
  type ChokePoint,
  type CollectionMetadataResolver,
  type DatabaseRow,
} from "@semprec/data";
import { CAPABILITY_IDS, type AuthenticatedActor } from "@semprec/shared";
import { createGenericOperationGateway } from "../genericOperationGateway.js";

// `page.ensureJournalPeriod` and the summary an agent writes into a Journal period (issue #1861).

const metadataResolver: CollectionMetadataResolver = {
  resolve: () => ({
    icon: null,
    color: null,
    overviewOrder: null,
    switcherOrder: null,
    clientVisible: true,
    overviewHidden: false,
  }),
  collectionFilter: () => undefined,
  overviewHideable: () => false,
};

const ALL_CAPABILITIES = new Set(CAPABILITY_IDS);
const FORBIDDEN = { status: 403, code: "forbidden" };
const SEEDING_TEST_TIMEOUT_MS = 120_000;

let pool: Pool;
let chokePoint: ChokePoint;
let journal: DatabaseRow;
let projectsDatabase: DatabaseRow;
let userId: string;

const gateway = () => createGenericOperationGateway(pool, metadataResolver);
const human = (): AuthenticatedActor => ({ userId, restSession: true });
/** `/mcp` on a human session: no run credential, so no project. */
const mcpHumanSession = (): AuthenticatedActor => ({ userId });

/** A run credential's actor: a run of a fresh Projects item, as the AgentTool and MCP composition roots build it. */
async function newAgent(): Promise<AuthenticatedActor> {
  const projectItemId = (await chokePoint.createItem({ databaseId: projectsDatabase.id, properties: {} })).id;
  const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "journal period" });
  return { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };
}

async function setJournalGrant(actor: AuthenticatedActor, access: AgentDatabaseAccess) {
  if (actor.agentProjectItemId === undefined) throw new Error("Not an agent actor");
  // The user-only admin store is not exported from `@semprec/data`, so a fixture writes the decision directly.
  await withTransaction(pool, (client) =>
    client.query(
      `INSERT INTO agent_database_grants (project_item_id, database_id, access) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, project_item_id, database_id) DO UPDATE SET access = EXCLUDED.access, updated_at = now()`,
      [actor.agentProjectItemId, journal.id, access],
    ),
  );
}

async function setJournalSensitive(sensitive: boolean): Promise<void> {
  // A non-sensitive system database is always open and its grant rows are ignored (docs/adr/2026-11-12-per-database-agent-grants.md),
  // so the one way to make the grant on Journal decide is the flag the product sets on the Health and sleep databases.
  await pool.query(`UPDATE databases SET sensitive = $2 WHERE id = $1`, [journal.id, sensitive]);
}

async function entriesOf(period: string, type: string): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM items WHERE database_id = $1 AND properties ->> 'period' = $2 AND properties ->> 'type' = $3
       AND deleted_at IS NULL ORDER BY id`,
    [journal.id, period, type],
  );
  return rows.map((row) => row.id);
}

async function updateAuthors(itemId: string): Promise<string[]> {
  const { rows } = await pool.query<{ created_by: string }>(
    `SELECT u.created_by FROM doc_updates u JOIN docs d ON d.id = u.doc_id WHERE d.item_id = $1 ORDER BY u.id`,
    [itemId],
  );
  return rows.map((row) => row.created_by);
}

async function approvalRequestCount(): Promise<number> {
  return (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM approval_requests")).rows[0]?.n ?? -1;
}

describe("page.ensureJournalPeriod through the generic operation gateway (issue #1861)", () => {
  beforeAll(async () => {
    pool = getTestPool();
    chokePoint = createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    userId = (await createTenantZeroUser(pool)).id;
    const databases = await inTenantZero(async () => ({
      journal: await withTransaction(pool, (client) => getDatabaseByModuleId(client, "journal")),
      projects: await withTransaction(pool, (client) => getDatabaseByModuleId(client, "projects")),
    }));
    if (!databases.journal || !databases.projects) throw new Error("System databases are missing");
    journal = databases.journal;
    projectsDatabase = databases.projects;
  }, SEEDING_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await pool?.end();
  });

  it("creates the week containing 2026-10-16 as 2026-W42, appends the agent's text at the end of its page authored ai_agent, and asks for no approval", async () => {
    await inTenantZero(async () => {
      const agent = await newAgent();
      expect(await entriesOf("2026-W42", "week")).toEqual([]);
      const requestsBefore = await approvalRequestCount();

      const ensured = await gateway().invoke("page.ensureJournalPeriod", agent, ALL_CAPABILITIES, {
        type: "week",
        date: "2026-10-16",
      });
      expect(ensured).toEqual({
        itemId: expect.any(String),
        docId: expect.any(String),
        period: "2026-W42",
        range: { from: "2026-10-12", to: "2026-10-18" },
      });
      expect(await entriesOf("2026-W42", "week")).toEqual([ensured.itemId]);

      await gateway().invoke("page.insert", human(), ALL_CAPABILITIES, {
        itemId: ensured.itemId,
        placement: "end",
        markdown: "Planned: the release",
      });
      const inserted = await gateway().invoke("page.insert", agent, ALL_CAPABILITIES, {
        itemId: ensured.itemId,
        placement: "end",
        markdown: "Sprint summary: the release shipped",
      });
      expect(inserted.blockIds).toHaveLength(1);

      const summary = await gateway().invoke("page.get", agent, ALL_CAPABILITIES, { itemId: ensured.itemId });
      expect("blocks" in summary ? summary.blocks.map((block) => block.text) : []).toEqual([
        "Planned: the release",
        "Sprint summary: the release shipped",
      ]);
      expect(await updateAuthors(ensured.itemId)).toEqual(["user", "ai_agent"]);
      expect(await approvalRequestCount()).toBe(requestsBefore);
    });
  });

  it("names the period by its key or by a date inside it and returns the same entry both ways, creating no second one", async () => {
    await inTenantZero(async () => {
      const agent = await newAgent();
      const byKey = await gateway().invoke("page.ensureJournalPeriod", agent, ALL_CAPABILITIES, {
        type: "month",
        period: "2027-03",
      });
      const byDate = await gateway().invoke("page.ensureJournalPeriod", agent, ALL_CAPABILITIES, {
        type: "month",
        date: "2027-03-31",
      });
      const again = await gateway().invoke("page.ensureJournalPeriod", agent, ALL_CAPABILITIES, {
        type: "month",
        period: "2027-03",
      });
      expect(byDate).toEqual(byKey);
      expect(again).toEqual(byKey);
      expect(await entriesOf("2027-03", "month")).toEqual([byKey.itemId]);
    });
  });

  it("returns the entry a person already created, keeping its page and its content", async () => {
    await inTenantZero(async () => {
      const agent = await newAgent();
      const created = await gateway().invoke("page.ensureJournalPeriod", human(), ALL_CAPABILITIES, {
        type: "day",
        date: "2027-04-01",
      });
      await gateway().invoke("page.insert", human(), ALL_CAPABILITIES, {
        itemId: created.itemId,
        placement: "end",
        markdown: "Written by a person",
      });

      const found = await gateway().invoke("page.ensureJournalPeriod", agent, ALL_CAPABILITIES, {
        type: "day",
        period: "2027-04-01",
      });

      expect(found).toEqual(created);
      expect(await entriesOf("2027-04-01", "day")).toEqual([created.itemId]);
      expect(await updateAuthors(created.itemId)).toEqual(["user"]);
    });
  });

  it("answers 400 for an unknown type, a malformed or non-existent period, a date that is no day, and neither or both of date and period, creating nothing", async () => {
    await inTenantZero(async () => {
      const agent = await newAgent();
      const before = (
        await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM items WHERE database_id = $1`, [journal.id])
      ).rows[0]?.n;
      const refused: unknown[] = [
        { type: "decade", date: "2027-04-02" },
        { type: "week", period: "2027-W53" },
        { type: "week", period: "2027-W99" },
        { type: "day", period: "not-a-day" },
        { type: "day", period: "2027-02-30" },
        { type: "day", date: "2027-02-30" },
        { type: "day" },
        { type: "day", date: "2027-04-02", period: "2027-04-02" },
        { date: "2027-04-02" },
      ];
      for (const input of refused) {
        await expect(
          gateway().invoke("page.ensureJournalPeriod", agent, ALL_CAPABILITIES, input),
          JSON.stringify(input),
        ).rejects.toMatchObject({ status: 400 });
      }
      const after = (
        await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM items WHERE database_id = $1`, [journal.id])
      ).rows[0]?.n;
      expect(after).toBe(before);
    });
  });

  it("answers 403 forbidden, creating no entry, to a run whose project may only read the Journal, and serves the same run with write access", async () => {
    await inTenantZero(async () => {
      const agent = await newAgent();
      await setJournalSensitive(true);
      try {
        await expect(
          gateway().invoke("page.ensureJournalPeriod", agent, ALL_CAPABILITIES, { type: "day", date: "2027-05-01" }),
        ).rejects.toMatchObject(FORBIDDEN);
        await setJournalGrant(agent, "read");
        await expect(
          gateway().invoke("page.ensureJournalPeriod", agent, ALL_CAPABILITIES, { type: "day", date: "2027-05-01" }),
        ).rejects.toMatchObject(FORBIDDEN);
        expect(await entriesOf("2027-05-01", "day")).toEqual([]);

        await setJournalGrant(agent, "write");
        const ensured = await gateway().invoke("page.ensureJournalPeriod", agent, ALL_CAPABILITIES, {
          type: "day",
          date: "2027-05-01",
        });
        expect(await entriesOf("2027-05-01", "day")).toEqual([ensured.itemId]);
      } finally {
        await setJournalSensitive(false);
      }
    });
  });

  it("is open to a run without a grant record on the Journal, a person and an /mcp human session", async () => {
    await inTenantZero(async () => {
      const periods = [
        ["2027-06-01", await newAgent()],
        ["2027-06-02", human()],
        ["2027-06-03", mcpHumanSession()],
      ] as const;
      for (const [date, actor] of periods) {
        const ensured = await gateway().invoke("page.ensureJournalPeriod", actor, ALL_CAPABILITIES, {
          type: "day",
          date,
        });
        expect(ensured.period).toBe(date);
      }
    });
  });

  it("is served under core.item.write alone and is absent for a run that holds only core.item.read", async () => {
    await inTenantZero(async () => {
      const agent = await newAgent();
      const readOnly = new Set(["core.item.read"] as const);
      const writeOnly = new Set(["core.item.write"] as const);
      expect(gateway().listOperations(readOnly)).not.toContain("page.ensureJournalPeriod");
      expect(gateway().listOperations(writeOnly)).toContain("page.ensureJournalPeriod");
      await expect(
        gateway().invoke("page.ensureJournalPeriod", agent, readOnly, { type: "day", date: "2027-07-01" }),
      ).rejects.toMatchObject({ status: 404 });
      expect(await entriesOf("2027-07-01", "day")).toEqual([]);
      const ensured = await gateway().invoke("page.ensureJournalPeriod", agent, writeOnly, {
        type: "day",
        date: "2027-07-01",
      });
      expect(ensured.period).toBe("2027-07-01");
    });
  });
});
