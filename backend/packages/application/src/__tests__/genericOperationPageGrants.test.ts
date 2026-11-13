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
  ensureJournalPeriodDoc,
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

// The page operations of an agent run, held to its project's grant on the database that owns the page and to the
// approval of `page.replace` and `page.restoreVersion` (issue #1844).

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
const DAY = "2026-10-16";

let pool: Pool;
let chokePoint: ChokePoint;
let health: DatabaseRow;
let journal: DatabaseRow;
let projectsDatabase: DatabaseRow;
let userId: string;

const gateway = () => createGenericOperationGateway(pool, metadataResolver);
const docStore = () => createDocStore(pool);
const human = (): AuthenticatedActor => ({ userId, restSession: true });
/** `/mcp` on a human session: no run credential, so no project. */
const mcpHumanSession = (): AuthenticatedActor => ({ userId });

async function setGrant(actor: AuthenticatedActor, database: DatabaseRow, access: AgentDatabaseAccess) {
  if (actor.agentProjectItemId === undefined) throw new Error("Not an agent actor");
  const projectItemId = actor.agentProjectItemId;
  // The user-only admin store is not exported from `@semprec/data`, so a fixture writes the decision directly.
  await withTransaction(pool, (client) =>
    client.query(
      `INSERT INTO agent_database_grants (project_item_id, database_id, access) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, project_item_id, database_id) DO UPDATE SET access = EXCLUDED.access, updated_at = now()`,
      [projectItemId, database.id, access],
    ),
  );
}

/** A run credential's actor: a run of a fresh Projects item, as the AgentTool and MCP composition roots build it. */
async function newAgent(): Promise<AuthenticatedActor> {
  const projectItemId = (await chokePoint.createItem({ databaseId: projectsDatabase.id, properties: {} })).id;
  const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "page grants" });
  return { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };
}

async function newUserDatabase(name: string): Promise<DatabaseRow> {
  const database = await chokePoint.createDatabase({ name });
  await chokePoint.createProperty({ databaseId: database.id, key: "name", name: "Name", type: "title" });
  return database;
}

/** A user-created database with one item, the host of the pages of a test. */
async function newHost(name = "Release notes") {
  const database = await newUserDatabase(`Notes ${name}`);
  const item = await chokePoint.createItem({ databaseId: database.id, properties: { name } });
  return { database, item };
}

async function pagesOf(itemId: string): Promise<string> {
  const page = await gateway().invoke("page.get", human(), ALL_CAPABILITIES, { itemId, format: "markdown" });
  if (!("markdown" in page)) throw new Error("Expected the Markdown format");
  return page.markdown;
}

async function etagOf(itemId: string): Promise<string> {
  const page = await gateway().invoke("page.get", human(), ALL_CAPABILITIES, { itemId, format: "markdown" });
  if (!("etag" in page)) throw new Error("Expected the Markdown format");
  return page.etag;
}

/** Writes `markdown` to the end of the page as a person, so the page has a document and a version. */
async function seedPage(itemId: string, markdown: string): Promise<void> {
  await gateway().invoke("page.insert", human(), ALL_CAPABILITIES, { itemId, placement: "end", markdown });
}

async function blockIdsOf(itemId: string): Promise<string[]> {
  const blocks = await docStore().listBlocks(itemId);
  return blocks.map((block) => String(block["sys:id"])).sort();
}

/** Gives the page a history that starts two hours back and returns an instant inside it, so a restore is accepted. */
async function historyInstant(itemId: string): Promise<Date> {
  const doc = await docStore().getOrCreateDoc(itemId, "page");
  const { rows } = await pool.query<{ now: Date }>(`SELECT transaction_timestamp() AS now`);
  const now = rows[0]?.now;
  if (!now) throw new Error("Missing database clock");
  const hoursBefore = (hours: number) => new Date(now.getTime() - hours * 60 * 60 * 1000);
  await pool.query(`UPDATE docs SET history_available_from = $2 WHERE id = $1`, [doc.id, hoursBefore(2)]);
  await pool.query(`UPDATE doc_snapshot_history SET represented_at = $2 WHERE doc_id = $1 AND through_update_id = 0`, [
    doc.id,
    hoursBefore(2),
  ]);
  return hoursBefore(0.5);
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

async function approvedRequest(id: string) {
  await withTransaction(pool, (client) =>
    decideAndEnqueueApprovalRequest(client, { approvalRequestId: id, decision: "approved", decidedByUserId: userId }),
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

async function pagesItemCount(): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM items i JOIN databases d ON d.id = i.database_id WHERE d.key = 'pages'`,
  );
  return rows[0]?.n ?? -1;
}

async function lastUpdateAuthor(itemId: string): Promise<string | undefined> {
  const { rows } = await pool.query<{ created_by: string }>(
    `SELECT u.created_by FROM doc_updates u JOIN docs d ON d.id = u.doc_id WHERE d.item_id = $1 ORDER BY u.id DESC LIMIT 1`,
    [itemId],
  );
  return rows[0]?.created_by;
}

/** Marks the Journal restricted or open again: the grants model restricts only what is sensitive or user-created. */
async function setJournalSensitive(sensitive: boolean): Promise<void> {
  // A non-sensitive system database is always open and its grant rows are ignored (docs/adr/2026-11-12-per-database-agent-grants.md),
  // so the one way to make the grant on Journal decide is the flag the product sets on the Health and sleep databases.
  await pool.query(`UPDATE databases SET sensitive = $2 WHERE id = $1`, [journal.id, sensitive]);
}

describe("agent access to pages through the generic operation gateway (issue #1844)", () => {
  beforeAll(async () => {
    pool = getTestPool();
    chokePoint = createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    userId = (await createTenantZeroUser(pool)).id;
    const databases = await inTenantZero(async () => ({
      health: await withTransaction(pool, (client) => getDatabaseByModuleId(client, "healthRecords")),
      journal: await withTransaction(pool, (client) => getDatabaseByModuleId(client, "journal")),
      projects: await withTransaction(pool, (client) => getDatabaseByModuleId(client, "projects")),
    }));
    if (!databases.health || !databases.journal || !databases.projects) throw new Error("System databases are missing");
    health = databases.health;
    journal = databases.journal;
    projectsDatabase = databases.projects;
  }, SEEDING_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await pool?.end();
  });

  it("reads the notes of a project as Markdown with a link to its subpage, and as a summary with the block ids", async () => {
    await inTenantZero(async () => {
      const agent = await newAgent();
      const project = agent.agentProjectItemId;
      if (project === undefined) throw new Error("Missing project");
      const created = await gateway().invoke("page.createSubpage", agent, ALL_CAPABILITIES, {
        parent: { itemId: project },
        title: "Release checklist",
      });
      const subpage = created.pages[0];
      if (!subpage) throw new Error("Missing subpage");
      await gateway().invoke("page.insert", agent, ALL_CAPABILITIES, {
        itemId: project,
        placement: "end",
        markdown: "Ship on Friday",
      });

      const markdown = await gateway().invoke("page.get", agent, ALL_CAPABILITIES, {
        itemId: project,
        format: "markdown",
      });
      expect("markdown" in markdown ? markdown.markdown : "").toContain(
        `[Release checklist](semprec://page/${subpage.pageItemId})`,
      );
      const summary = await gateway().invoke("page.get", agent, ALL_CAPABILITIES, { itemId: project });
      expect("blocks" in summary ? summary.blocks : []).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: subpage.blockId, type: "page", pageId: subpage.pageItemId }),
        ]),
      );
      expect(await lastUpdateAuthor(project)).toBe("ai_agent");
    });
  });

  describe("the read operations", () => {
    it("page.get is refused with 403 to a project whose grant on the owner database is none and served with read, in both formats", async () => {
      await inTenantZero(async () => {
        const agent = await newAgent();
        const host = await newHost();
        await seedPage(host.item.id, "Private text");
        const reads = {
          "page.get summary": () => gateway().invoke("page.get", agent, ALL_CAPABILITIES, { itemId: host.item.id }),
          "page.get markdown": () =>
            gateway().invoke("page.get", agent, ALL_CAPABILITIES, { itemId: host.item.id, format: "markdown" }),
        };

        await setGrant(agent, host.database, "none");
        for (const [name, read] of Object.entries(reads)) await expect(read(), name).rejects.toMatchObject(FORBIDDEN);

        await setGrant(agent, host.database, "read");
        expect(await reads["page.get summary"]()).toMatchObject({ kind: "page" });
        expect(await reads["page.get markdown"]()).toMatchObject({ markdown: expect.stringContaining("Private text") });
      });
    });

    it("page.changes is served for a readable page and refused for an unreadable one", async () => {
      await inTenantZero(async () => {
        const agent = await newAgent();
        const host = await newHost();
        const since = new Date(Date.now() - 60_000).toISOString();
        await setGrant(agent, host.database, "none");
        await expect(
          gateway().invoke("page.changes", agent, ALL_CAPABILITIES, { itemId: host.item.id, since }),
        ).rejects.toMatchObject(FORBIDDEN);
        await setGrant(agent, host.database, "read");
        // The page has no document yet, so it has no changes.
        expect(
          await gateway().invoke("page.changes", agent, ALL_CAPABILITIES, { itemId: host.item.id, since }),
        ).toEqual([]);
      });
    });

    it("a sensitive database hides the page of its item until a grant opens it, for reading only with a read grant", async () => {
      await inTenantZero(async () => {
        const agent = await newAgent();
        const record = await chokePoint.createItem({
          databaseId: health.id,
          properties: { name: "Private diagnosis" },
        });
        await expect(
          gateway().invoke("page.get", agent, ALL_CAPABILITIES, { itemId: record.id }),
        ).rejects.toMatchObject(FORBIDDEN);
        await expect(
          gateway().invoke("page.insert", agent, ALL_CAPABILITIES, {
            itemId: record.id,
            placement: "end",
            markdown: "Refused",
          }),
        ).rejects.toMatchObject(FORBIDDEN);

        await setGrant(agent, health, "read");
        expect(await gateway().invoke("page.get", agent, ALL_CAPABILITIES, { itemId: record.id })).toMatchObject({
          docId: null,
        });
        await expect(
          gateway().invoke("page.insert", agent, ALL_CAPABILITIES, {
            itemId: record.id,
            placement: "end",
            markdown: "Still refused",
          }),
        ).rejects.toMatchObject(FORBIDDEN);
        expect(await docStore().getDoc(record.id)).toBeNull();
      });
    });

    it("names an ancestor in a database the project may not read by its id only in the breadcrumbs, and shows it once a grant opens it", async () => {
      await inTenantZero(async () => {
        const agent = await newAgent();
        const record = await chokePoint.createItem({
          databaseId: health.id,
          properties: { name: "Private diagnosis" },
        });
        const nested = await chokePoint.createInlineDatabase({ name: "Nested notes", parentItemId: record.id });
        await chokePoint.createProperty({ databaseId: nested.id, key: "name", name: "Name", type: "title" });
        const note = await chokePoint.createItem({ databaseId: nested.id, properties: { name: "Open note" } });
        const breadcrumbsOf = async (actor: AuthenticatedActor) => {
          const page = await gateway().invoke("page.get", actor, ALL_CAPABILITIES, { itemId: note.id });
          if (!("breadcrumbs" in page)) throw new Error("Expected the summary format");
          return page.breadcrumbs;
        };
        const trail = (ancestor: object) => [
          ancestor,
          { itemId: note.id, title: "Open note", databaseKey: nested.key },
        ];

        expect(await breadcrumbsOf(agent)).toEqual(
          trail({ itemId: record.id, title: "", databaseKey: null, hidden: true }),
        );
        expect(await breadcrumbsOf(human())).toEqual(
          trail({ itemId: record.id, title: "Private diagnosis", databaseKey: health.key }),
        );
        await setGrant(agent, health, "read");
        expect(await breadcrumbsOf(agent)).toEqual(
          trail({ itemId: record.id, title: "Private diagnosis", databaseKey: health.key }),
        );
      });
    });
  });

  describe("the write operations", () => {
    async function pageWithSubpage() {
      const host = await newHost();
      await seedPage(host.item.id, "Intro");
      const created = await gateway().invoke("page.createSubpage", human(), ALL_CAPABILITIES, {
        parent: { itemId: host.item.id },
        title: "Child",
      });
      const subpage = created.pages[0];
      if (!subpage) throw new Error("Missing subpage");
      return { ...host, subpageId: subpage.pageItemId };
    }

    it("are refused with 403 to a project that may only read the owner database, writing and requesting nothing", async () => {
      await inTenantZero(async () => {
        const agent = await newAgent();
        const host = await pageWithSubpage();
        const bare = await newHost("Bare");
        const at = await historyInstant(host.item.id);
        const etag = await etagOf(host.item.id);
        await setGrant(agent, host.database, "read");
        await setGrant(agent, bare.database, "read");
        const before = {
          blocks: await blockIdsOf(host.item.id),
          markdown: await pagesOf(host.item.id),
          pages: await pagesItemCount(),
          requests: await requestCount(),
        };
        const writes = {
          "page.ensure": () => gateway().invoke("page.ensure", agent, ALL_CAPABILITIES, { itemId: bare.item.id }),
          "page.createSubpage": () =>
            gateway().invoke("page.createSubpage", agent, ALL_CAPABILITIES, {
              parent: { itemId: host.item.id },
              title: "Refused",
            }),
          "page.duplicate": () =>
            gateway().invoke("page.duplicate", agent, ALL_CAPABILITIES, { pageItemId: host.subpageId }),
          "page.rename": () =>
            gateway().invoke("page.rename", agent, ALL_CAPABILITIES, { pageItemId: host.subpageId, title: "Renamed" }),
          "page.insert": () =>
            gateway().invoke("page.insert", agent, ALL_CAPABILITIES, {
              itemId: host.item.id,
              placement: "end",
              markdown: "Refused",
            }),
          "page.replace": () =>
            gateway().invoke("page.replace", agent, ALL_CAPABILITIES, {
              itemId: host.item.id,
              markdown: "Refused",
              expectedEtag: etag,
            }),
          "page.restoreVersion": () =>
            gateway().invoke("page.restoreVersion", agent, ALL_CAPABILITIES, {
              itemId: host.item.id,
              at: at.toISOString(),
            }),
        };

        for (const [name, write] of Object.entries(writes))
          await expect(write(), name).rejects.toMatchObject(FORBIDDEN);

        expect({
          blocks: await blockIdsOf(host.item.id),
          markdown: await pagesOf(host.item.id),
          pages: await pagesItemCount(),
          requests: await requestCount(),
        }).toEqual(before);
        expect(await docStore().getDoc(bare.item.id)).toBeNull();
        expect(await lastUpdateAuthor(host.item.id)).toBe("user");
      });
    });

    it("run for a project with a write grant, and ask for approval only for page.replace and page.restoreVersion", async () => {
      await inTenantZero(async () => {
        const agent = await newAgent();
        const host = await pageWithSubpage();
        const bare = await newHost("Bare");
        const at = await historyInstant(host.item.id);
        const etag = await etagOf(host.item.id);
        await setGrant(agent, host.database, "write");
        await setGrant(agent, bare.database, "write");

        expect(await gateway().invoke("page.ensure", agent, ALL_CAPABILITIES, { itemId: bare.item.id })).toMatchObject({
          docId: expect.any(String),
        });
        const created = await gateway().invoke("page.createSubpage", agent, ALL_CAPABILITIES, {
          parent: { itemId: host.item.id },
          title: "Created",
        });
        expect(created.pages).toHaveLength(1);
        expect(
          await gateway().invoke("page.duplicate", agent, ALL_CAPABILITIES, { pageItemId: host.subpageId }),
        ).toMatchObject({ pageItemId: expect.any(String) });
        expect(
          await gateway().invoke("page.rename", agent, ALL_CAPABILITIES, {
            pageItemId: host.subpageId,
            title: "Renamed",
          }),
        ).toMatchObject({ title: "Renamed" });
        const inserted = await gateway().invoke("page.insert", agent, ALL_CAPABILITIES, {
          itemId: host.item.id,
          placement: "end",
          markdown: "Added by the agent",
        });
        expect(inserted.blockIds).toHaveLength(1);
        expect(await lastUpdateAuthor(host.item.id)).toBe("ai_agent");

        const before = await requestCount();
        const replaceId = await requestIdOf(async () =>
          gateway().invoke("page.replace", agent, ALL_CAPABILITIES, {
            itemId: host.item.id,
            markdown: "Replaced",
            expectedEtag: await etagOf(host.item.id),
          }),
        );
        const restoreId = await requestIdOf(() =>
          gateway().invoke("page.restoreVersion", agent, ALL_CAPABILITIES, {
            itemId: host.item.id,
            at: at.toISOString(),
          }),
        );
        expect(await requestCount()).toBe(before + 2);
        expect(await pagesOf(host.item.id)).toContain("Added by the agent");
        expect(replaceId).not.toBe(restoreId);
        expect(etag).not.toBe(await etagOf(host.item.id));
      });
    });

    it("follow the grant on the root host's database for a subpage, and a Projects item without a row stays writable", async () => {
      await inTenantZero(async () => {
        const agent = await newAgent();
        const host = await pageWithSubpage();
        await setGrant(agent, host.database, "read");
        const insert = (itemId: string) =>
          gateway().invoke("page.insert", agent, ALL_CAPABILITIES, { itemId, placement: "end", markdown: "Note" });

        expect(await gateway().invoke("page.get", agent, ALL_CAPABILITIES, { itemId: host.subpageId })).toMatchObject({
          kind: "page",
        });
        await expect(insert(host.subpageId)).rejects.toMatchObject(FORBIDDEN);
        await setGrant(agent, host.database, "write");
        expect((await insert(host.subpageId)).blockIds).toHaveLength(1);

        const project = agent.agentProjectItemId;
        if (project === undefined) throw new Error("Missing project");
        expect((await insert(project)).blockIds).toHaveLength(1);
      });
    });
  });

  describe("a Journal day", () => {
    it("is written by a project without a grant record on the open Journal, authored ai_agent", async () => {
      await inTenantZero(async () => {
        const agent = await newAgent();
        const day = await withTransaction(pool, (client) => ensureJournalPeriodDoc(client, "day", DAY));
        const inserted = await gateway().invoke("page.insert", agent, ALL_CAPABILITIES, {
          itemId: day.itemId,
          placement: "end",
          markdown: "Sprint summary",
        });
        expect(inserted.blockIds).toHaveLength(1);
        expect(await lastUpdateAuthor(day.itemId)).toBe("ai_agent");
        const created = await gateway().invoke("page.createSubpage", agent, ALL_CAPABILITIES, {
          parent: { journal: { type: "day", period: DAY } },
          title: "Retro",
        });
        expect(created.pages).toHaveLength(1);
      });
    });

    it("is refused with 403 for a write, and for a new period created under it, once the grant on Journal is read, and read as before", async () => {
      await inTenantZero(async () => {
        const agent = await newAgent();
        const day = await withTransaction(pool, (client) => ensureJournalPeriodDoc(client, "day", DAY));
        const blocksBefore = await blockIdsOf(day.itemId);
        await setJournalSensitive(true);
        try {
          await expect(
            gateway().invoke("page.get", agent, ALL_CAPABILITIES, { itemId: day.itemId }),
          ).rejects.toMatchObject(FORBIDDEN);
          await setGrant(agent, journal, "read");
          expect(await gateway().invoke("page.get", agent, ALL_CAPABILITIES, { itemId: day.itemId })).toMatchObject({
            docId: day.docId,
          });
          await expect(
            gateway().invoke("page.insert", agent, ALL_CAPABILITIES, {
              itemId: day.itemId,
              placement: "end",
              markdown: "Refused",
            }),
          ).rejects.toMatchObject(FORBIDDEN);
          const before = await pool.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM items WHERE database_id = $1`,
            [journal.id],
          );
          await expect(
            gateway().invoke("page.createSubpage", agent, ALL_CAPABILITIES, {
              parent: { journal: { type: "day", period: "2026-10-17" } },
              title: "Refused",
            }),
          ).rejects.toMatchObject(FORBIDDEN);
          const after = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM items WHERE database_id = $1`, [
            journal.id,
          ]);
          expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
          expect(await blockIdsOf(day.itemId)).toEqual(blocksBefore);

          await setGrant(agent, journal, "write");
          const inserted = await gateway().invoke("page.insert", agent, ALL_CAPABILITIES, {
            itemId: day.itemId,
            placement: "end",
            markdown: "Allowed",
          });
          expect(inserted.blockIds).toHaveLength(1);
        } finally {
          await setJournalSensitive(false);
        }
      });
    });
  });

  describe("page.replace", () => {
    async function pageWithBody() {
      const host = await newHost();
      await seedPage(host.item.id, "First line\n\nSecond line");
      const created = await gateway().invoke("page.createSubpage", human(), ALL_CAPABILITIES, {
        parent: { itemId: host.item.id },
        title: "Child page",
      });
      const subpage = created.pages[0];
      if (!subpage) throw new Error("Missing subpage");
      return { ...host, subpageId: subpage.pageItemId };
    }

    it("is held for approval for an agent while page.insert is not, and changes nothing until the request is replayed", async () => {
      await inTenantZero(async () => {
        const agent = await newAgent();
        const host = await pageWithBody();
        const before = await pagesOf(host.item.id);
        const requestsBefore = await requestCount();

        const requestId = await requestIdOf(async () =>
          gateway().invoke("page.replace", agent, ALL_CAPABILITIES, {
            itemId: host.item.id,
            markdown: "Only this",
            expectedEtag: await etagOf(host.item.id),
          }),
        );
        expect(await getApprovalRequest(pool, requestId)).toMatchObject({
          toolName: "page.replace",
          riskClass: "destructive",
          status: "pending",
          description: {
            key: "approval.pageReplace",
            params: { itemName: "Release notes", databaseKey: null, databaseName: "Notes Release notes" },
          },
        });
        expect(await pagesOf(host.item.id)).toBe(before);

        const inserted = await gateway().invoke("page.insert", agent, ALL_CAPABILITIES, {
          itemId: host.item.id,
          placement: "end",
          markdown: "Not held",
        });
        expect(inserted.blockIds).toHaveLength(1);
        expect(await requestCount()).toBe(requestsBefore + 1);
        expect(await lastUpdateAuthor(host.item.id)).toBe("ai_agent");
      });
    });

    it("replays an approved request as one user update that trashes the subpage the new body no longer links", async () => {
      await inTenantZero(async () => {
        const agent = await newAgent();
        const host = await pageWithBody();
        const etag = await etagOf(host.item.id);
        const requestId = await requestIdOf(() =>
          gateway().invoke("page.replace", agent, ALL_CAPABILITIES, {
            itemId: host.item.id,
            markdown: "Brand new body",
            expectedEtag: etag,
          }),
        );

        const outcome = await replayApprovedGenericOperation(pool, await approvedRequest(requestId));

        expect(outcome.error).toBe(false);
        expect((await getApprovalRequest(pool, requestId))?.executionStatus).toBe("succeeded");
        expect(await pagesOf(host.item.id)).toBe("Brand new body");
        expect(await lastUpdateAuthor(host.item.id)).toBe("user");
        expect((await chokePoint.findItemIncludingDeleted(host.subpageId))?.deletedAt).not.toBeNull();
      });
    });

    it("ends the replay as a conflict, replacing nothing, when the page changed after the request", async () => {
      await inTenantZero(async () => {
        const agent = await newAgent();
        const host = await pageWithBody();
        const requestId = await requestIdOf(async () =>
          gateway().invoke("page.replace", agent, ALL_CAPABILITIES, {
            itemId: host.item.id,
            markdown: "Brand new body",
            expectedEtag: await etagOf(host.item.id),
          }),
        );
        await seedPage(host.item.id, "Edited meanwhile");
        const edited = await pagesOf(host.item.id);

        const outcome = await replayApprovedGenericOperation(pool, await approvedRequest(requestId));

        expect(outcome.error).toBe(true);
        expect((await getApprovalRequest(pool, requestId))?.executionStatus).toBe("conflict");
        expect(await pagesOf(host.item.id)).toBe(edited);
      });
    });

    it("ends the replay as a conflict, replacing nothing, when the grant was revoked after the request", async () => {
      await inTenantZero(async () => {
        const agent = await newAgent();
        const host = await pageWithBody();
        await setGrant(agent, host.database, "write");
        const requestId = await requestIdOf(async () =>
          gateway().invoke("page.replace", agent, ALL_CAPABILITIES, {
            itemId: host.item.id,
            markdown: "Brand new body",
            expectedEtag: await etagOf(host.item.id),
          }),
        );
        const request = await approvedRequest(requestId);
        const before = await pagesOf(host.item.id);
        await setGrant(agent, host.database, "read");

        const outcome = await replayApprovedGenericOperation(pool, request);

        expect(outcome.error).toBe(true);
        expect((await getApprovalRequest(pool, requestId))?.executionStatus).toBe("conflict");
        expect(await pagesOf(host.item.id)).toBe(before);
      });
    });

    it("refuses a stale version with 409 and a link to a page that is not a subpage with 400, creating no request", async () => {
      await inTenantZero(async () => {
        const agent = await newAgent();
        const host = await pageWithBody();
        const stale = await etagOf(host.item.id);
        await seedPage(host.item.id, "Moved on");
        const before = await requestCount();

        await expect(
          gateway().invoke("page.replace", agent, ALL_CAPABILITIES, {
            itemId: host.item.id,
            markdown: "Too late",
            expectedEtag: stale,
          }),
        ).rejects.toMatchObject({ status: 409, code: "version_conflict" });
        await expect(
          gateway().invoke("page.replace", agent, ALL_CAPABILITIES, {
            itemId: host.item.id,
            markdown: `[Elsewhere](semprec://page/${host.item.id})`,
            expectedEtag: await etagOf(host.item.id),
          }),
        ).rejects.toMatchObject({ status: 400 });
        expect(await requestCount()).toBe(before);
      });
    });

    it("answers not found, creating no request, for an item that does not exist", async () => {
      await inTenantZero(async () => {
        const agent = await newAgent();
        const before = await requestCount();
        await expect(
          gateway().invoke("page.replace", agent, ALL_CAPABILITIES, {
            itemId: "00000000-0000-4000-8000-000000000001",
            markdown: "Nowhere",
            expectedEtag: "A".repeat(43),
          }),
        ).rejects.toMatchObject({ status: 404 });
        expect(await requestCount()).toBe(before);
      });
    });
  });

  describe("page.restoreVersion", () => {
    it("ends an approved request as a conflict, restoring nothing, once the grant was revoked, and restores with the grant", async () => {
      await inTenantZero(async () => {
        const agent = await newAgent();
        const host = await newHost();
        await seedPage(host.item.id, "Before");
        const at = await historyInstant(host.item.id);
        await setGrant(agent, host.database, "write");
        const ask = () =>
          requestIdOf(() =>
            gateway().invoke("page.restoreVersion", agent, ALL_CAPABILITIES, {
              itemId: host.item.id,
              at: at.toISOString(),
            }),
          );
        const granted = await approvedRequest(await ask());
        const revoked = await approvedRequest(await ask());

        expect((await replayApprovedGenericOperation(pool, granted)).error).toBe(false);
        expect(await blockIdsOf(host.item.id)).toEqual([]);

        await seedPage(host.item.id, "After");
        await setGrant(agent, host.database, "read");
        expect((await replayApprovedGenericOperation(pool, revoked)).error).toBe(true);
        expect((await getApprovalRequest(pool, revoked.id))?.executionStatus).toBe("conflict");
        expect(await pagesOf(host.item.id)).toBe("After");
      });
    });
  });

  it("does not run the per-project check for a person or for an /mcp call on a human session", async () => {
    await inTenantZero(async () => {
      const agent = await newAgent();
      const host = await newHost();
      await setGrant(agent, host.database, "none");
      await expect(
        gateway().invoke("page.get", agent, ALL_CAPABILITIES, { itemId: host.item.id }),
      ).rejects.toMatchObject(FORBIDDEN);

      for (const actor of [human(), mcpHumanSession()]) {
        await gateway().invoke("page.insert", actor, ALL_CAPABILITIES, {
          itemId: host.item.id,
          placement: "end",
          markdown: "Written without a project",
        });
        expect(await gateway().invoke("page.get", actor, ALL_CAPABILITIES, { itemId: host.item.id })).toMatchObject({
          kind: "page",
        });
      }
    });
  });
});
