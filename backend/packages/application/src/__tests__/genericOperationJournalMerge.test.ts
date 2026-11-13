import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createTenantZeroUser, getTestPool, inTenantZero, resetDatabase } from "@semprec/data/testSupport";
import {
  ApprovalRequiredError,
  createAgentRun,
  createChokePoint,
  createItemWithClient,
  createViewTypeRegistry,
  decideAndEnqueueApprovalRequest,
  getApprovalRequest,
  getDatabaseByModuleId,
  isGenericOperationApprovalRequestPayload,
  seedSystem,
  withTransaction,
  type AgentDatabaseAccess,
  type ChokePoint,
  type CollectionMetadataResolver,
  type DatabaseRow,
} from "@semprec/data";
import { CAPABILITY_IDS, type AuthenticatedActor } from "@semprec/shared";
import { createGenericOperationGateway, replayApprovedGenericOperation } from "../genericOperationGateway.js";

// `page.mergeJournalDuplicates` of an agent run through the generic operation gateway (issue #2017): the call is held
// for approval, the approved request merges the entries once, and the grant on the Journal database decides who may ask.

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
/** One calendar day per test, so no test sees the entries of another. */
let dayCounter = 0;

const gateway = () => createGenericOperationGateway(pool, metadataResolver);
const human = (): AuthenticatedActor => ({ userId, restSession: true });
/** `/mcp` on a human session: no run credential, so no project. */
const mcpHumanSession = (): AuthenticatedActor => ({ userId });

function nextDay(): string {
  dayCounter += 1;
  return `2038-04-${String(dayCounter).padStart(2, "0")}`;
}

/** A run credential's actor: a run of a fresh Projects item, as the AgentTool and MCP composition roots build it. */
async function newAgent(): Promise<AuthenticatedActor> {
  const projectItemId = (await chokePoint.createItem({ databaseId: projectsDatabase.id, properties: {} })).id;
  const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "journal merge" });
  return { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };
}

async function setGrant(actor: AuthenticatedActor, access: AgentDatabaseAccess) {
  if (actor.agentProjectItemId === undefined) throw new Error("Not an agent actor");
  const projectItemId = actor.agentProjectItemId;
  // The user-only admin store is not exported from `@semprec/data`, so a fixture writes the decision directly.
  await withTransaction(pool, (client) =>
    client.query(
      `INSERT INTO agent_database_grants (project_item_id, database_id, access) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, project_item_id, database_id) DO UPDATE SET access = EXCLUDED.access, updated_at = now()`,
      [projectItemId, journal.id, access],
    ),
  );
}

/** Marks the Journal restricted or open again: the grants model restricts only what is sensitive or user-created. */
async function setJournalSensitive(sensitive: boolean): Promise<void> {
  // A non-sensitive system database is always open and its grant rows are ignored (docs/adr/2026-11-12-per-database-agent-grants.md),
  // so the one way to make the grant on Journal decide is the flag the product sets on the Health and sleep databases.
  await pool.query(`UPDATE databases SET sensitive = $2 WHERE id = $1`, [journal.id, sensitive]);
}

/**
 * One live entry of a day. Two live entries of one period are a state the lazy creation never produces (it reuses the
 * live entry), so the fixture creates them directly.
 */
async function entry(period: string, name: string): Promise<string> {
  return withTransaction(
    pool,
    async (client) =>
      (
        await createItemWithClient(
          client,
          { databaseId: journal.id, properties: { name, type: "day", period } },
          { allowedSystemKeys: ["name", "type", "period"] },
        )
      ).id,
  );
}

/** Two live entries of a day, the first created the older. Each page holds text of its own. */
async function duplicatedDay() {
  const period = nextDay();
  const older = await entry(period, `\u{1F4D3} ${period} first`);
  const newer = await entry(period, `\u{1F4D3} ${period} second`);
  await gateway().invoke("page.insert", human(), ALL_CAPABILITIES, {
    itemId: older,
    placement: "end",
    markdown: "Text of the older entry",
  });
  await gateway().invoke("page.insert", human(), ALL_CAPABILITIES, {
    itemId: newer,
    placement: "end",
    markdown: "Text of the newer entry",
  });
  return { period, older, newer };
}

/** The ids of `ids` that are live, in id order. */
async function liveOf(ids: readonly string[]): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM items WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY id",
    [ids],
  );
  return rows.map((row) => row.id);
}

function sorted(ids: readonly string[]): string[] {
  return [...ids].sort();
}

async function pageOf(itemId: string): Promise<string> {
  const page = await gateway().invoke("page.get", human(), ALL_CAPABILITIES, { itemId, format: "markdown" });
  if (!("markdown" in page)) throw new Error("Expected the Markdown format");
  return page.markdown;
}

async function requestIdOf(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (error) {
    if (error instanceof ApprovalRequiredError) return error.details.approvalRequestId;
    throw error;
  }
  throw new Error("Expected the call to ask for approval");
}

function askToMerge(agent: AuthenticatedActor, period: string, type = "day") {
  return gateway().invoke("page.mergeJournalDuplicates", agent, ALL_CAPABILITIES, { type, period });
}

async function decided(id: string, decision: "approved" | "rejected") {
  await withTransaction(pool, (client) =>
    decideAndEnqueueApprovalRequest(client, { approvalRequestId: id, decision, decidedByUserId: userId }),
  );
  const request = await getApprovalRequest(pool, id);
  if (!request || !isGenericOperationApprovalRequestPayload(request.payload)) {
    throw new Error("Missing generic approval request");
  }
  return { ...request, payload: request.payload };
}

async function requestCount(): Promise<number> {
  return (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM approval_requests")).rows[0]?.n ?? -1;
}

describe("page.mergeJournalDuplicates through the generic operation gateway (issue #2017)", () => {
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

  it("holds an agent's call for a day with two live entries as a pending request that names the period and the two entries, and changes nothing", async () => {
    await inTenantZero(async () => {
      const agent = await newAgent();
      const { period, older, newer } = await duplicatedDay();
      const pagesBefore = [await pageOf(older), await pageOf(newer)];
      const requestsBefore = await requestCount();

      const requestId = await requestIdOf(() => askToMerge(agent, period));

      expect(await requestCount()).toBe(requestsBefore + 1);
      const request = await getApprovalRequest(pool, requestId);
      expect(request).toMatchObject({
        toolName: "page.mergeJournalDuplicates",
        riskClass: "destructive",
        status: "pending",
        description: {
          key: "approval.journalMerge",
          params: {
            periodType: "day",
            period,
            survivorName: `\u{1F4D3} ${period} first`,
            mergedName: `\u{1F4D3} ${period} second`,
          },
        },
      });
      // The summary and the notification carry the period and the titles, and no page content.
      expect(JSON.stringify(request?.description)).not.toContain("Text of the");
      expect(await liveOf([older, newer])).toEqual(sorted([older, newer]));
      expect([await pageOf(older), await pageOf(newer)]).toEqual(pagesBefore);
      const notification = await pool.query<{ body: string }>(
        `SELECT body FROM notifications WHERE source_table = 'approval_requests' AND source_id = $1`,
        [requestId],
      );
      expect(notification.rows[0]?.body).toContain(period);
      // The recipient's locale is Czech: the period type is the localised word, not the canonical key "day".
      expect(notification.rows[0]?.body).toContain(`za den ${period}`);
      expect(notification.rows[0]?.body).not.toContain(`day ${period}`);
      expect(notification.rows[0]?.body).toContain(`\u{1F4D3} ${period} second`);
      expect(notification.rows[0]?.body).not.toContain("Text of the");
    });
  });

  it("merges the entries exactly once when the user approves, and a second replay of the request changes nothing", async () => {
    await inTenantZero(async () => {
      const agent = await newAgent();
      const { period, older, newer } = await duplicatedDay();
      const requestId = await requestIdOf(() => askToMerge(agent, period));
      const request = await decided(requestId, "approved");

      const outcome = await replayApprovedGenericOperation(pool, request);

      expect(outcome.error).toBe(false);
      expect(JSON.parse(outcome.result)).toEqual({ result: { survivorId: older, mergedItemId: newer } });
      expect((await getApprovalRequest(pool, requestId))?.executionStatus).toBe("succeeded");
      expect(await liveOf([older, newer])).toEqual([older]);
      expect((await chokePoint.findItemIncludingDeleted(newer))?.deletedAt).not.toBeNull();
      const merged = await pageOf(older);
      expect(merged).toContain("Text of the older entry");
      expect(merged).toContain("Text of the newer entry");

      const again = await replayApprovedGenericOperation(pool, request);

      expect(again).toEqual(outcome);
      expect(await pageOf(older)).toBe(merged);
      expect(await liveOf([older, newer])).toEqual([older]);
    });
  });

  it("leaves both entries live when the user rejects the request, and refuses to replay it", async () => {
    await inTenantZero(async () => {
      const agent = await newAgent();
      const { period, older, newer } = await duplicatedDay();
      const requestId = await requestIdOf(() => askToMerge(agent, period));
      const request = await decided(requestId, "rejected");

      expect(request.status).toBe("rejected");
      await expect(replayApprovedGenericOperation(pool, request)).rejects.toMatchObject({ status: 403 });

      expect(await liveOf([older, newer])).toEqual(sorted([older, newer]));
    });
  });

  it("answers { merged: false } after the approval of a call for a period without a duplicate, and leaves its one entry live", async () => {
    await inTenantZero(async () => {
      const agent = await newAgent();
      const withOne = nextDay();
      const only = await entry(withOne, `\u{1F4D3} ${withOne}`);
      const withNone = nextDay();

      for (const period of [withOne, withNone]) {
        const requestId = await requestIdOf(() => askToMerge(agent, period));
        expect((await getApprovalRequest(pool, requestId))?.status).toBe("pending");
        const outcome = await replayApprovedGenericOperation(pool, await decided(requestId, "approved"));

        expect(outcome.error).toBe(false);
        expect(JSON.parse(outcome.result)).toEqual({ result: { merged: false } });
        expect((await getApprovalRequest(pool, requestId))?.executionStatus).toBe("succeeded");
      }
      expect(await liveOf([only])).toEqual([only]);
    });
  });

  describe("an approved request that no longer matches what the user was shown", () => {
    it("ends as a conflict, merging nothing, when one of the two entries left the period after the request", async () => {
      await inTenantZero(async () => {
        const agent = await newAgent();
        const { period, older, newer } = await duplicatedDay();
        const requestId = await requestIdOf(() => askToMerge(agent, period));
        const request = await decided(requestId, "approved");
        await chokePoint.softDeleteItem(journal.id, newer);

        const outcome = await replayApprovedGenericOperation(pool, request);

        expect(outcome.error).toBe(true);
        expect((await getApprovalRequest(pool, requestId))?.executionStatus).toBe("conflict");
        expect(await liveOf([older, newer])).toEqual([older]);
      });
    });

    it("ends as a conflict, merging nothing, when a duplicate appeared after the request that named none", async () => {
      await inTenantZero(async () => {
        const agent = await newAgent();
        const period = nextDay();
        const older = await entry(period, `\u{1F4D3} ${period}`);
        const requestId = await requestIdOf(() => askToMerge(agent, period));
        const request = await decided(requestId, "approved");
        const newer = await entry(period, `\u{1F4D3} ${period} again`);

        const outcome = await replayApprovedGenericOperation(pool, request);

        expect(outcome.error).toBe(true);
        expect((await getApprovalRequest(pool, requestId))?.executionStatus).toBe("conflict");
        expect(await liveOf([older, newer])).toEqual(sorted([older, newer]));
      });
    });

    it("ends as a conflict, merging nothing, when the project lost its write access after the request", async () => {
      await inTenantZero(async () => {
        const agent = await newAgent();
        const { period, older, newer } = await duplicatedDay();
        await setJournalSensitive(true);
        try {
          await setGrant(agent, "write");
          const requestId = await requestIdOf(() => askToMerge(agent, period));
          const request = await decided(requestId, "approved");
          await setGrant(agent, "read");

          const outcome = await replayApprovedGenericOperation(pool, request);

          expect(outcome.error).toBe(true);
          expect((await getApprovalRequest(pool, requestId))?.executionStatus).toBe("conflict");
          expect(await liveOf([older, newer])).toEqual(sorted([older, newer]));
        } finally {
          await setJournalSensitive(false);
        }
      });
    });
  });

  describe("the grant on the Journal database", () => {
    it("refuses a run whose project may only read the restricted Journal with 403 forbidden, creating no request and merging nothing", async () => {
      await inTenantZero(async () => {
        const agent = await newAgent();
        const { period, older, newer } = await duplicatedDay();
        await setJournalSensitive(true);
        try {
          await setGrant(agent, "read");
          const requestsBefore = await requestCount();

          await expect(askToMerge(agent, period)).rejects.toMatchObject(FORBIDDEN);

          expect(await requestCount()).toBe(requestsBefore);
          expect(await liveOf([older, newer])).toEqual(sorted([older, newer]));

          // The allowed side: the same call with write access is held for approval.
          await setGrant(agent, "write");
          const requestId = await requestIdOf(() => askToMerge(agent, period));
          expect((await getApprovalRequest(pool, requestId))?.status).toBe("pending");
        } finally {
          await setJournalSensitive(false);
        }
      });
    });

    it("holds the call of a project without a grant record on the open Journal for approval", async () => {
      await inTenantZero(async () => {
        const agent = await newAgent();
        const { period } = await duplicatedDay();

        const requestId = await requestIdOf(() => askToMerge(agent, period));

        expect((await getApprovalRequest(pool, requestId))?.status).toBe("pending");
      });
    });
  });

  describe("the input", () => {
    it("refuses an unknown type and a malformed or non-existent period with 400, creating no request", async () => {
      await inTenantZero(async () => {
        const agent = await newAgent();
        const requestsBefore = await requestCount();
        const refusals: Array<[string, string, string]> = [
          ["decade", "2026", "type"],
          ["week", "2027-W53", "period"],
          ["month", "2026-13", "period"],
          ["day", "2026-02-30", "period"],
          ["day", "tomorrow", "period"],
          ["week", "2026-10-16", "period"],
        ];

        for (const [type, period, field] of refusals) {
          await expect(askToMerge(agent, period, type), `${type} ${period}`).rejects.toMatchObject({
            status: 400,
            details: { field },
          });
          await expect(askToMerge(human(), period, type), `person: ${type} ${period}`).rejects.toMatchObject({
            status: 400,
            details: { field },
          });
        }

        expect(await requestCount()).toBe(requestsBefore);
      });
    });

    it("refuses an input with a field of another operation", async () => {
      await inTenantZero(async () => {
        await expect(
          gateway().invoke("page.mergeJournalDuplicates", human(), ALL_CAPABILITIES, {
            type: "day",
            period: nextDay(),
            itemId: "x",
          }),
        ).rejects.toMatchObject({ status: 400 });
      });
    });
  });

  describe("a call that is not an agent run's", () => {
    it("merges at once for a person and for a human /mcp session, without an approval request", async () => {
      await inTenantZero(async () => {
        for (const actor of [human(), mcpHumanSession()]) {
          const { period, older, newer } = await duplicatedDay();
          const requestsBefore = await requestCount();

          const result = await gateway().invoke("page.mergeJournalDuplicates", actor, ALL_CAPABILITIES, {
            type: "day",
            period,
          });

          expect(result).toEqual({ survivorId: older, mergedItemId: newer });
          expect(await liveOf([older, newer])).toEqual([older]);
          expect(await requestCount()).toBe(requestsBefore);
        }
      });
    });

    it("answers { merged: false } to a person for a period without a duplicate", async () => {
      await inTenantZero(async () => {
        const period = nextDay();
        const only = await entry(period, `\u{1F4D3} ${period}`);

        expect(
          await gateway().invoke("page.mergeJournalDuplicates", human(), ALL_CAPABILITIES, { type: "day", period }),
        ).toEqual({
          merged: false,
        });
        expect(await liveOf([only])).toEqual([only]);
      });
    });
  });

  it("is listed under the item-write capability and under no other", async () => {
    const withWrite = new Set(["core.item.write" as const]);
    const withRead = new Set(["core.item.read" as const, "core.page.write" as const]);

    expect(gateway().listOperations(withWrite)).toContain("page.mergeJournalDuplicates");
    expect(gateway().listOperations(withRead)).not.toContain("page.mergeJournalDuplicates");
    await expect(
      gateway().invoke("page.mergeJournalDuplicates", human(), withRead, { type: "day", period: nextDay() }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
