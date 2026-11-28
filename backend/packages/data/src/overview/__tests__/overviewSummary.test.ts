import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runAsSystem, runInTenant } from "@alldots/shared";
import { createAgentRun } from "../../agentRuns/agentRunsStore.js";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { getDatabaseByModuleId, listAllDatabases } from "../../chokePoint/databasesStore.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../../db/pool.js";
import { createInboxCardsCountRouteHandler } from "../../inbox/inboxRouteHandlers.js";
import { LocalFsBlobStorageWriter } from "../../mail/blobStorage.js";
import { ensureFolderItem } from "../../mail/folderDiscovery.js";
import { ingestEmailMessage } from "../../mail/ingest.js";
import { resolveMailModuleIds } from "../../mail/mailModuleIds.js";
import { createMailSummaryRouteHandler } from "../../mail/mailSummary.js";
import {
  createCollectionMetadataResolver,
  type CollectionMetadataResolver,
} from "../../manifest/collectionMetadata.js";
import { loadFullModuleRegistry } from "../../manifest/fullModuleRegistry.js";
import { createPendingApprovalRequest } from "../../mcp/approvalRequestsStore.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { raiseProblem } from "../../semp/sempProblemsStore.js";
import { createSempStatusSummaryRouteHandler } from "../../semp/sempStatusRouteHandler.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createOverviewRouteHandler, overviewSummarySchema } from "../overviewRouteHandler.js";
import { getOverviewSummary, type OverviewSummary } from "../overviewSummary.js";

/** Friday 16 October 2026, 12:00 in Europe/Prague, the zone of a seeded tenant. */
const NOW = new Date("2026-10-16T10:00:00.000Z");

interface Tenant {
  id: string;
  userId: string;
}

let admin: Pool;
let runtime: Pool;
let cp: ChokePoint;
let resolver: CollectionMetadataResolver;
let storageRoot: string;
let storage: LocalFsBlobStorageWriter;
let tenant: Tenant;

/** On the runtime role, so row-level security applies. */
function inTenant<T>(owner: Tenant, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(owner.id, () => withTransaction(runtime, fn));
}

async function newTenant(): Promise<Tenant> {
  const id = await createTestTenant(admin);
  await runInTenant(id, () => seedSystem(runtime, createViewTypeRegistry()));
  // `users` is a global identity table, written outside the tenant scope as account creation does.
  const user = await createUser(admin, { email: `${randomUUID()}@example.com`, passwordHash: "unused", tenantId: id });
  return { id, userId: user.id };
}

function summaryOf(owner: Tenant, userId: string = owner.userId): Promise<OverviewSummary> {
  return runInTenant(owner.id, () => getOverviewSummary(runtime, { ownerUserId: userId }));
}

/** A pending approval request of a tick run of `userId`; the Inbox counts it for that user only. */
async function pendingApproval(owner: Tenant, userId: string): Promise<void> {
  await runInTenant(owner.id, async () => {
    const run = await createAgentRun(runtime, { triggeredBy: "heartbeat", task: "overview probe", userId });
    await createPendingApprovalRequest(runtime, {
      agentRunId: run.id,
      toolName: "probe",
      riskClass: "unclassified",
      payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
      resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
    });
  });
}

/** An open Processing proposals card of kind `inbox`, written as the Inbox pipeline writes one. */
async function proposalCard(owner: Tenant): Promise<void> {
  await inTenant(owner, async (client) => {
    const proposals = await getDatabaseByModuleId(client, "processingProposals");
    if (!proposals) throw new Error("No processingProposals database");
    await createItemWithClient(
      client,
      { databaseId: proposals.id, properties: { kind: "inbox", status: "proposed", proposal: null } },
      { allowedSystemKeys: ["kind", "status", "proposal"] },
    );
  });
}

async function unreadMessages(owner: Tenant, count: number): Promise<void> {
  await inTenant(owner, async (client) => {
    const ids = await resolveMailModuleIds(client);
    const propertyId = async (databaseIdOfProperty: string, key: string): Promise<string> => {
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM properties WHERE database_id = $1 AND key = $2",
        [databaseIdOfProperty, key],
      );
      const id = rows[0]?.id;
      if (!id) throw new Error(`property '${key}' is not seeded`);
      return id;
    };
    const mailbox = await createItemWithClient(client, {
      databaseId: ids.mailboxesDatabaseId,
      properties: { name: "Personal", provider: "generic" },
    });
    const folder = await ensureFolderItem(client, {
      foldersDatabaseId: ids.foldersDatabaseId,
      mailboxItemId: mailbox.id,
      mailboxRelationPropertyId: await propertyId(ids.foldersDatabaseId, "mailbox"),
      providerId: "inbox",
      name: "inbox",
      behavior: "folder",
      specialPurpose: "inbox",
    });
    for (let n = 0; n < count; n += 1) {
      await ingestEmailMessage(client, {
        arrival: "live",
        contentState: "full",
        emailsDatabaseId: ids.emailsDatabaseId,
        filesDatabaseId: ids.filesDatabaseId,
        folderRelationPropertyId: await propertyId(ids.emailsDatabaseId, "folder"),
        attachmentsRelationPropertyId: await propertyId(ids.emailsDatabaseId, "attachments"),
        folderItemId: folder,
        mailboxItemId: mailbox.id,
        messageId: `<overview-${randomUUID()}@example.test>`,
        inReplyTo: null,
        references: [],
        subject: "Overview probe",
        envelope: {
          from: { name: "Sender", address: "sender@example.test" },
          to: [{ name: "Me", address: "me@example.test" }],
        },
        bodyText: "body",
        flags: [],
        attachments: [],
        storage,
        storageKeyPrefix: "overview-summary",
      });
    }
  });
}

beforeAll(async () => {
  admin = getTestPool();
  runtime = await createRuntimeRolePool(admin, "alldots_data");
  const role = await runAsSystem("verify overview summary test role", () =>
    runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    ),
  );
  expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  cp = createChokePoint(runtime);
  resolver = await createCollectionMetadataResolver(await loadFullModuleRegistry());
  storageRoot = await mkdtemp(join(tmpdir(), "alldots-overview-summary-"));
  storage = new LocalFsBlobStorageWriter(storageRoot);
}, 120_000);

beforeEach(async () => {
  await resetDatabase(admin);
  tenant = await newTenant();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await resetDatabase(admin);
  await runtime?.end();
  await admin?.end();
  await rm(storageRoot, { recursive: true, force: true });
});

describe("getOverviewSummary (issue gh-1837)", () => {
  it("equals what the owners' routes answer on the same data", async () => {
    await proposalCard(tenant);
    await proposalCard(tenant);
    await pendingApproval(tenant, tenant.userId);
    await unreadMessages(tenant, 2);
    await inTenant(tenant, (client) =>
      raiseProblem(client, {
        userId: tenant.userId,
        category: "mail",
        kind: "mailSyncError",
        severity: "critical",
        sourceTable: "items",
        sourceId: randomUUID(),
        dedupeKey: "overview-problem",
      }),
    );

    const summary = await summaryOf(tenant);

    const inbox = await runInTenant(tenant.id, () =>
      createInboxCardsCountRouteHandler(runtime)({ identity: { user: { id: tenant.userId } } }),
    );
    expect(inbox).toEqual({ status: 200, body: { total: 3 } });
    expect(summary.inboxPending).toBe(3);

    const mail = await runInTenant(tenant.id, () => createMailSummaryRouteHandler(runtime)());
    expect(mail.body.unreadInbox).toBe(2);
    expect(summary.mailUnread).toBe(mail.body.unreadInbox);

    const semp = await runInTenant(tenant.id, () => createSempStatusSummaryRouteHandler(runtime)());
    // The stored mail problem and the missing AI budget of a fresh tenant.
    expect(semp.body.activeCount).toBe(2);
    expect(summary.problemCount).toBe(semp.body.activeCount);
  });

  it("reads every figure on one pool connection", async () => {
    await unreadMessages(tenant, 1);
    let connections = 0;
    let poolQueries = 0;
    const counting = new Proxy(runtime, {
      get(target, key, receiver) {
        if (key === "connect") {
          return (): Promise<PoolClient> => {
            connections += 1;
            return target.connect();
          };
        }
        if (key === "query") {
          return (...args: unknown[]): unknown => {
            poolQueries += 1;
            return Reflect.apply(target.query.bind(target), undefined, args);
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const summary = await runInTenant(tenant.id, () => getOverviewSummary(counting, { ownerUserId: tenant.userId }));
    expect(summary.mailUnread).toBe(1);
    expect({ connections, poolQueries }).toEqual({ connections: 1, poolQueries: 0 });
  });

  it("counts the approvals of the user it is given and not of another user", async () => {
    await pendingApproval(tenant, tenant.userId);

    expect((await summaryOf(tenant, tenant.userId)).inboxPending).toBe(1);
    expect((await summaryOf(tenant, randomUUID())).inboxPending).toBe(0);
  });

  it("lists every client-visible system database in database order, without counts", async () => {
    const userDatabase = await runInTenant(tenant.id, () => cp.createDatabase({ name: "Mine" }));

    const { collections } = await summaryOf(tenant);

    const databases = await inTenant(tenant, (client) => listAllDatabases(client));
    const expected = databases.flatMap((database) =>
      database.ownerModuleId !== null && resolver.resolve(database).clientVisible
        ? [{ databaseId: database.id, ownerModuleId: database.ownerModuleId }]
        : [],
    );
    expect(expected.length).toBeGreaterThan(0);
    expect(collections).toEqual(expected);
    expect(collections.map((collection) => collection.databaseId)).not.toContain(userDatabase.id);
    // A system database that no client lists is not a collection.
    const excluded = databases.filter(
      (database) => database.ownerModuleId !== null && !resolver.resolve(database).clientVisible,
    );
    expect(excluded.length).toBeGreaterThan(0);
    const listed = collections.map((collection) => collection.databaseId);
    expect(excluded.filter((database) => listed.includes(database.id))).toEqual([]);
  });

  it("answers zero counts for a tenant that has no rows of its own", async () => {
    const summary = await summaryOf(tenant);

    // The one problem is the missing AI budget of a fresh tenant.
    expect(summary).toEqual({ inboxPending: 0, mailUnread: 0, problemCount: 1, collections: summary.collections });
    expect(summary.collections.length).toBeGreaterThan(0);
  });

  it("throws without a tenant scope and in a system scope, and reads nothing", async () => {
    const message = "getOverviewSummary requires an active tenant scope";

    await expect(getOverviewSummary(runtime, { ownerUserId: tenant.userId })).rejects.toThrow(message);
    await expect(
      runAsSystem("overview summary test", () => getOverviewSummary(runtime, { ownerUserId: tenant.userId })),
    ).rejects.toThrow(message);
  });

  it("shows nothing of another tenant in any field", async () => {
    const foreign = await newTenant();
    await proposalCard(foreign);
    await pendingApproval(foreign, foreign.userId);
    await unreadMessages(foreign, 3);
    await inTenant(foreign, (client) =>
      raiseProblem(client, {
        userId: foreign.userId,
        category: "mail",
        kind: "mailSyncError",
        severity: "critical",
        sourceTable: "items",
        sourceId: randomUUID(),
        dedupeKey: "overview-foreign-problem",
      }),
    );

    // The other tenant sees its own rows, so they exist and are countable.
    const ofForeign = await summaryOf(foreign);
    expect(ofForeign).toMatchObject({ inboxPending: 2, mailUnread: 3, problemCount: 2 });

    const own = await summaryOf(tenant);
    expect(own).toMatchObject({
      inboxPending: 0,
      mailUnread: 0,
      // The missing AI budget of a fresh tenant; the other tenant's stored problem is not counted.
      problemCount: 1,
    });
    const foreignDatabaseIds = ofForeign.collections.map((collection) => collection.databaseId);
    expect(
      own.collections.map((collection) => collection.databaseId).filter((id) => foreignDatabaseIds.includes(id)),
    ).toEqual([]);
    expect(own.collections.length).toBe(ofForeign.collections.length);
  });
});

describe("createOverviewRouteHandler (issue gh-1837)", () => {
  it("answers 200 with the summary of the session user, in the shape the schema declares", async () => {
    await proposalCard(tenant);
    await pendingApproval(tenant, tenant.userId);

    const answer = await runInTenant(tenant.id, () =>
      createOverviewRouteHandler(runtime)({ identity: { user: { id: tenant.userId } } }),
    );

    expect(answer.status).toBe(200);
    const body = overviewSummarySchema.parse(answer.body);
    expect(body.inboxPending).toBe(2);
    expect(Object.keys(body).sort()).toEqual(["collections", "inboxPending", "mailUnread", "problemCount"]);
  });

  it("counts the approvals of the session user and not of another user", async () => {
    await pendingApproval(tenant, tenant.userId);
    const stranger = randomUUID();

    const handler = createOverviewRouteHandler(runtime);
    const own = await runInTenant(tenant.id, () => handler({ identity: { user: { id: tenant.userId } } }));
    const other = await runInTenant(tenant.id, () => handler({ identity: { user: { id: stranger } } }));

    expect(overviewSummarySchema.parse(own.body).inboxPending).toBe(1);
    expect(overviewSummarySchema.parse(other.body).inboxPending).toBe(0);
  });

  it("rejects a body with a field the schema does not declare, a negative count and a malformed id", async () => {
    const collection = { databaseId: randomUUID(), ownerModuleId: "tasks" };
    const valid: OverviewSummary = { inboxPending: 0, mailUnread: 0, collections: [collection], problemCount: 0 };
    expect(overviewSummarySchema.safeParse(valid).success).toBe(true);
    expect(overviewSummarySchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(overviewSummarySchema.safeParse({ ...valid, mailUnread: -1 }).success).toBe(false);
    expect(
      overviewSummarySchema.safeParse({ ...valid, collections: [{ ...collection, databaseId: "x" }] }).success,
    ).toBe(false);
    expect(overviewSummarySchema.safeParse({ ...valid, collections: [{ ...collection, itemCount: 0 }] }).success).toBe(
      false,
    );
  });
});
