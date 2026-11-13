import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createTenantZeroUser, getTestPool, inTenantZero, resetDatabase } from "@semprec/data/testSupport";
import {
  ApprovalRequiredError,
  createAgentRun,
  createChokePoint,
  createDocStore,
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

// `page.convertToBlock` of an agent run through the generic operation gateway (issue #1876): the call is held for
// approval, the approved request trashes the page tree and writes the block once, and the grant on the database that
// owns the parent page decides who may ask.

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
let projectsDatabase: DatabaseRow;
let userId: string;

const gateway = () => createGenericOperationGateway(pool, metadataResolver);
const human = (): AuthenticatedActor => ({ userId, restSession: true });
/** `/mcp` on a human session: no run credential, so no project. */
const mcpHumanSession = (): AuthenticatedActor => ({ userId });

/** A run credential's actor: a run of a fresh Projects item, as the AgentTool and MCP composition roots build it. */
async function newAgent(): Promise<AuthenticatedActor> {
  const projectItemId = (await chokePoint.createItem({ databaseId: projectsDatabase.id, properties: {} })).id;
  const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "page convert" });
  return { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };
}

interface Fixture {
  databaseId: string;
  host: string;
  checklist: { pageItemId: string; blockId: string };
  notes: { pageItemId: string; blockId: string };
}

/** A user-created database with one item; its page holds the text "Intro" and the page block of "Release checklist", which holds a nested page "Release notes". */
async function hostWithPages(): Promise<Fixture> {
  const database = await chokePoint.createDatabase({ name: `Hosts ${Math.random()}` });
  const host = (await chokePoint.createItem({ databaseId: database.id, properties: {} })).id;
  const docStore = createDocStore(pool);
  await gateway().invoke("page.insert", human(), ALL_CAPABILITIES, {
    itemId: host,
    placement: "end",
    markdown: "Intro",
  });
  const checklist = (await docStore.createSubpage({ parent: { itemId: host }, title: "Release checklist" }, "user"))
    .pages[0];
  if (!checklist) throw new Error("Missing page");
  const notes = (
    await docStore.createSubpage({ parent: { itemId: checklist.pageItemId }, title: "Release notes" }, "user")
  ).pages[0];
  if (!notes) throw new Error("Missing nested page");
  return { databaseId: database.id, host, checklist, notes };
}

async function setGrant(actor: AuthenticatedActor, databaseId: string, access: AgentDatabaseAccess) {
  if (actor.agentProjectItemId === undefined) throw new Error("Not an agent actor");
  // The user-only admin store is not exported from `@semprec/data`, so a fixture writes the decision directly.
  await withTransaction(pool, (client) =>
    client.query(
      `INSERT INTO agent_database_grants (project_item_id, database_id, access) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, project_item_id, database_id) DO UPDATE SET access = EXCLUDED.access, updated_at = now()`,
      [actor.agentProjectItemId, databaseId, access],
    ),
  );
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

/** The blocks of the page of `itemId` as the summary reads them. */
async function blocksOf(itemId: string): Promise<Array<{ id: string; type: string; text: string }>> {
  const page = await gateway().invoke("page.get", human(), ALL_CAPABILITIES, { itemId, format: "summary" });
  if (!("blocks" in page)) throw new Error("Expected the summary format");
  return page.blocks.map((block) => ({ id: block.id, type: block.type, text: block.text }));
}

/** The id of the "Intro" block in the blocks of a fixture host's page. */
function introOf(blocks: Array<{ id: string; text: string }>): string {
  const intro = blocks.find((block) => block.text === "Intro");
  if (!intro) throw new Error("Missing the Intro block");
  return intro.id;
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

function askToConvert(
  actor: AuthenticatedActor,
  fixture: Fixture,
  overrides: Record<string, unknown> = {},
): Promise<unknown> {
  return gateway().invoke("page.convertToBlock", actor, ALL_CAPABILITIES, {
    parentItemId: fixture.host,
    blockId: fixture.checklist.blockId,
    type: "text",
    confirmedPageCount: 2,
    ...overrides,
  });
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

describe("page.convertToBlock through the generic operation gateway (issue #1876)", () => {
  beforeAll(async () => {
    pool = getTestPool();
    chokePoint = createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    userId = (await createTenantZeroUser(pool)).id;
    const projects = await inTenantZero(() =>
      withTransaction(pool, (client) => getDatabaseByModuleId(client, "projects")),
    );
    if (!projects) throw new Error("The Projects database is missing");
    projectsDatabase = projects;
  }, SEEDING_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await pool?.end();
  });

  it("names the page by the title its page block shows when the mirrored item title lags", async () => {
    await inTenantZero(async () => {
      const agent = await newAgent();
      const fixture = await hostWithPages();
      await setGrant(agent, fixture.databaseId, "write");
      await pool.query(`UPDATE items SET properties = jsonb_set(properties, '{title}', '"Old title"') WHERE id = $1`, [
        fixture.checklist.pageItemId,
      ]);

      const requestId = await requestIdOf(() => askToConvert(agent, fixture));

      expect(await getApprovalRequest(pool, requestId)).toMatchObject({
        description: { params: { pageName: "Release checklist" } },
      });
    });
  });

  it("holds an agent's call as a pending request that names the page, the block type and the page count, and changes nothing", async () => {
    await inTenantZero(async () => {
      const agent = await newAgent();
      const fixture = await hostWithPages();
      await setGrant(agent, fixture.databaseId, "write");
      const blocksBefore = await blocksOf(fixture.host);
      const requestsBefore = await requestCount();

      const requestId = await requestIdOf(() => askToConvert(agent, fixture, { type: "h2" }));

      expect(await requestCount()).toBe(requestsBefore + 1);
      const request = await getApprovalRequest(pool, requestId);
      expect(request).toMatchObject({
        toolName: "page.convertToBlock",
        riskClass: "destructive",
        status: "pending",
        description: {
          key: "approval.pageConvertToBlock",
          params: { pageName: "Release checklist", blockType: "h2", pageCount: 2 },
        },
      });
      // The notification names the page and the count, and carries the block type as a localised phrase, not as "h2".
      const notification = await pool.query<{ body: string }>(
        `SELECT body FROM notifications WHERE source_table = 'approval_requests' AND source_id = $1`,
        [requestId],
      );
      const body = notification.rows[0]?.body ?? "";
      expect(body).toContain("Release checklist");
      expect(body).toContain("nadpis 2. úrovně");
      expect(body).not.toContain("h2");
      expect(await liveOf([fixture.checklist.pageItemId, fixture.notes.pageItemId])).toEqual(
        sorted([fixture.checklist.pageItemId, fixture.notes.pageItemId]),
      );
      expect(await blocksOf(fixture.host)).toEqual(blocksBefore);
    });
  });

  it("converts once when the user approves, as the agent that asked, and a second replay of the request changes nothing", async () => {
    await inTenantZero(async () => {
      const agent = await newAgent();
      const fixture = await hostWithPages();
      await setGrant(agent, fixture.databaseId, "write");
      const blocksBefore = await blocksOf(fixture.host);
      const requestId = await requestIdOf(() => askToConvert(agent, fixture));
      const request = await decided(requestId, "approved");

      const outcome = await replayApprovedGenericOperation(pool, request);

      expect(outcome.error).toBe(false);
      const { result } = JSON.parse(outcome.result) as { result: { blockId: string; trashedPageCount: number } };
      expect(result.trashedPageCount).toBe(2);
      expect((await getApprovalRequest(pool, requestId))?.executionStatus).toBe("succeeded");
      expect(await liveOf([fixture.checklist.pageItemId, fixture.notes.pageItemId])).toEqual([]);
      const converted = [
        { id: introOf(blocksBefore), type: "text", text: "Intro" },
        { id: result.blockId, type: "text", text: "Release checklist" },
      ];
      expect(await blocksOf(fixture.host)).toEqual(converted);
      // The trash is the agent's (its hook update is authored `ai_agent`); the new block is the approver's (`user`).
      const authors = await pool.query<{ created_by: string }>(
        `SELECT u.created_by FROM doc_updates u JOIN docs d ON d.id = u.doc_id WHERE d.item_id = $1 ORDER BY u.id`,
        [fixture.host],
      );
      expect(authors.rows.map((row) => row.created_by).slice(-2)).toEqual(["ai_agent", "user"]);

      const again = await replayApprovedGenericOperation(pool, request);

      expect(again).toEqual(outcome);
      expect(await blocksOf(fixture.host)).toEqual(converted);
    });
  });

  it("leaves the pages and the block as they were when the user rejects the request, and refuses to replay it", async () => {
    await inTenantZero(async () => {
      const agent = await newAgent();
      const fixture = await hostWithPages();
      await setGrant(agent, fixture.databaseId, "write");
      const blocksBefore = await blocksOf(fixture.host);
      const requestId = await requestIdOf(() => askToConvert(agent, fixture));
      const request = await decided(requestId, "rejected");

      expect(request.status).toBe("rejected");
      await expect(replayApprovedGenericOperation(pool, request)).rejects.toMatchObject({ status: 403 });

      expect(await liveOf([fixture.checklist.pageItemId, fixture.notes.pageItemId])).toEqual(
        sorted([fixture.checklist.pageItemId, fixture.notes.pageItemId]),
      );
      expect(await blocksOf(fixture.host)).toEqual(blocksBefore);
    });
  });

  describe("the count the call carries", () => {
    it("is refused with 409 and the current count at the call, creating no request", async () => {
      await inTenantZero(async () => {
        const agent = await newAgent();
        const fixture = await hostWithPages();
        await setGrant(agent, fixture.databaseId, "write");
        const requestsBefore = await requestCount();

        await expect(askToConvert(agent, fixture, { confirmedPageCount: 1 })).rejects.toMatchObject({
          status: 409,
          details: { currentPageCount: 2 },
        });

        expect(await requestCount()).toBe(requestsBefore);
      });
    });

    it("ends an approved request as a conflict, converting nothing, when a page appeared below the page after the request", async () => {
      await inTenantZero(async () => {
        const agent = await newAgent();
        const fixture = await hostWithPages();
        await setGrant(agent, fixture.databaseId, "write");
        const requestId = await requestIdOf(() => askToConvert(agent, fixture));
        const request = await decided(requestId, "approved");
        await createDocStore(pool).createSubpage(
          { parent: { itemId: fixture.notes.pageItemId }, title: "Appeared later" },
          "user",
        );
        const blocksBefore = await blocksOf(fixture.host);

        const outcome = await replayApprovedGenericOperation(pool, request);

        expect(outcome.error).toBe(true);
        expect((await getApprovalRequest(pool, requestId))?.executionStatus).toBe("conflict");
        expect(await liveOf([fixture.checklist.pageItemId, fixture.notes.pageItemId])).toEqual(
          sorted([fixture.checklist.pageItemId, fixture.notes.pageItemId]),
        );
        expect(await blocksOf(fixture.host)).toEqual(blocksBefore);
      });
    });
  });

  describe("the grant on the database that owns the parent page", () => {
    it.each<AgentDatabaseAccess>(["none", "read"])(
      "refuses a run whose project has %s access with 403 forbidden, creating no request and changing nothing",
      async (access) => {
        await inTenantZero(async () => {
          const agent = await newAgent();
          const fixture = await hostWithPages();
          await setGrant(agent, fixture.databaseId, access);
          const requestsBefore = await requestCount();

          await expect(askToConvert(agent, fixture)).rejects.toMatchObject(FORBIDDEN);

          expect(await requestCount()).toBe(requestsBefore);
          expect(await liveOf([fixture.checklist.pageItemId])).toEqual([fixture.checklist.pageItemId]);
        });
      },
    );

    it("holds the call of a project with write access for approval", async () => {
      await inTenantZero(async () => {
        const agent = await newAgent();
        const fixture = await hostWithPages();
        await setGrant(agent, fixture.databaseId, "write");

        const requestId = await requestIdOf(() => askToConvert(agent, fixture));

        expect((await getApprovalRequest(pool, requestId))?.status).toBe("pending");
      });
    });

    it("ends an approved request as a conflict, converting nothing, when the project lost its write access after the request", async () => {
      await inTenantZero(async () => {
        const agent = await newAgent();
        const fixture = await hostWithPages();
        await setGrant(agent, fixture.databaseId, "write");
        const requestId = await requestIdOf(() => askToConvert(agent, fixture));
        const request = await decided(requestId, "approved");
        await setGrant(agent, fixture.databaseId, "read");

        const outcome = await replayApprovedGenericOperation(pool, request);

        expect(outcome.error).toBe(true);
        expect((await getApprovalRequest(pool, requestId))?.executionStatus).toBe("conflict");
        expect(await liveOf([fixture.checklist.pageItemId, fixture.notes.pageItemId])).toEqual(
          sorted([fixture.checklist.pageItemId, fixture.notes.pageItemId]),
        );
      });
    });
  });

  describe("the input", () => {
    it("refuses the page type, an unknown type and a count out of range with 400, creating no request", async () => {
      await inTenantZero(async () => {
        const agent = await newAgent();
        const fixture = await hostWithPages();
        await setGrant(agent, fixture.databaseId, "write");
        const requestsBefore = await requestCount();
        const refusals: Array<[Record<string, unknown>, string]> = [
          [{ type: "page" }, "type"],
          [{ type: "heading" }, "type"],
          [{ confirmedPageCount: 0 }, "confirmedPageCount"],
          [{ confirmedPageCount: 2.5 }, "confirmedPageCount"],
          [{ blockId: "" }, "blockId"],
          [{ parentItemId: "not-a-uuid" }, "parentItemId"],
        ];

        for (const [overrides, field] of refusals) {
          for (const actor of [agent, human()]) {
            await expect(askToConvert(actor, fixture, overrides), JSON.stringify(overrides)).rejects.toMatchObject({
              status: 400,
              details: { field },
            });
          }
        }

        expect(await requestCount()).toBe(requestsBefore);
      });
    });

    it("refuses a block that is not a page block with 400 for an agent, creating no request", async () => {
      await inTenantZero(async () => {
        const agent = await newAgent();
        const fixture = await hostWithPages();
        await setGrant(agent, fixture.databaseId, "write");
        const requestsBefore = await requestCount();

        await expect(askToConvert(agent, fixture, { blockId: "no-such-block" })).rejects.toMatchObject({
          status: 400,
          details: { field: "blockId" },
        });

        expect(await requestCount()).toBe(requestsBefore);
      });
    });

    it("refuses an input with a field of another operation", async () => {
      await inTenantZero(async () => {
        const fixture = await hostWithPages();
        await expect(askToConvert(human(), fixture, { pageItemId: fixture.host })).rejects.toMatchObject({
          status: 400,
        });
      });
    });
  });

  describe("a call that is not an agent run's", () => {
    it("converts at once for a person and for a human /mcp session, without an approval request", async () => {
      await inTenantZero(async () => {
        for (const actor of [human(), mcpHumanSession()]) {
          const fixture = await hostWithPages();
          const requestsBefore = await requestCount();

          const result = await askToConvert(actor, fixture);

          expect(result).toMatchObject({ trashedPageCount: 2 });
          expect(await liveOf([fixture.checklist.pageItemId, fixture.notes.pageItemId])).toEqual([]);
          expect(await requestCount()).toBe(requestsBefore);
        }
      });
    });

    it("answers a person's stale count with 409 and the current count, trashing nothing", async () => {
      await inTenantZero(async () => {
        const fixture = await hostWithPages();

        await expect(askToConvert(human(), fixture, { confirmedPageCount: 3 })).rejects.toMatchObject({
          status: 409,
          details: { currentPageCount: 2 },
        });

        expect(await liveOf([fixture.checklist.pageItemId, fixture.notes.pageItemId])).toEqual(
          sorted([fixture.checklist.pageItemId, fixture.notes.pageItemId]),
        );
      });
    });
  });

  it("is listed under the item-write capability and under no other", async () => {
    const withWrite = new Set(["core.item.write" as const]);
    const withRead = new Set(["core.item.read" as const, "core.page.write" as const]);

    expect(gateway().listOperations(withWrite)).toContain("page.convertToBlock");
    expect(gateway().listOperations(withRead)).not.toContain("page.convertToBlock");
    await expect(
      gateway().invoke("page.convertToBlock", human(), withRead, {
        parentItemId: "00000000-0000-4000-8000-000000000001",
        blockId: "b",
        type: "text",
        confirmedPageCount: 1,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
