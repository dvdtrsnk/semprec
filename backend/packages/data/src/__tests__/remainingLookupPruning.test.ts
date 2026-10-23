import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { archiveDatabase, createDatabase } from "../chokePoint/databasesStore.js";
import { insertItem, softDeleteItem } from "../chokePoint/itemsStore.js";
import { createProperty } from "../chokePoint/propertiesStore.js";
import { createItemRelation, createRelationDefinition } from "../chokePoint/relationsStore.js";
import { addViewItem, listLiveViewItemsAfter } from "../chokePoint/viewItemsStore.js";
import { createView } from "../chokePoint/viewsStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { createBlob, deleteBlobIfUnreferenced, getBlob } from "../blobs/blobsStore.js";
import { ensureMailAccountSyncState } from "../mail/mailAccountSyncStateStore.js";
import { listPendingImapFlagWrites, recordDesiredMailMessageFlags } from "../mail/mailMessageFlagSyncStore.js";
import { generatePermissionManifest } from "../manifest/permissionManifest.js";
import { getActiveMailSyncProcessNames } from "../health/processHeartbeats.js";
import { getSystemHealthReport } from "../observability/systemHealthReport.js";

let pool: Pool;

/** Matches the statements that read or write `items`; `JOIN items` and `FROM items` both count. */
const ITEMS_STATEMENT = /\b(FROM|JOIN|UPDATE) items\b/;

interface RecordedStatement {
  text: string;
  values: unknown[];
}

interface PlanNode {
  "Relation Name"?: string;
  "One-Time Filter"?: string;
  Plans?: PlanNode[];
}

interface ScanSummary {
  statements: number;
  relations: Set<string>;
  falseFilter: boolean;
}

/** Runs `fn` in a transaction on the owner role that is always rolled back. */
async function inRolledBackTransaction(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await fn(client);
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

async function scopeTo(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
}

async function addTenant(client: PoolClient): Promise<string> {
  const { rows } = await client.query<{ id: string }>("INSERT INTO tenants (status) VALUES ('active') RETURNING id");
  const id = rows[0]?.id;
  if (!id) throw new Error("tenant was not inserted");
  return id;
}

function partitionName(databaseId: string): string {
  return `items_p_${databaseId.replaceAll("-", "")}`;
}

/** Wraps `client` so every statement reading or writing `items` is recorded, then forwards each call. */
function recordItemsStatements(client: PoolClient, sink: RecordedStatement[]): PoolClient {
  return new Proxy(client, {
    get(target, prop) {
      if (prop !== "query") return Reflect.get(target, prop, target) as unknown;
      return (text: unknown, values?: unknown[]) => {
        if (typeof text === "string" && ITEMS_STATEMENT.test(text)) sink.push({ text, values: values ?? [] });
        return (target.query as (...args: unknown[]) => unknown)(text, values);
      };
    },
  });
}

function walkPlan(node: PlanNode, visit: (node: PlanNode) => void): void {
  visit(node);
  for (const child of node.Plans ?? []) walkPlan(child, visit);
}

/** Runs `fn`, then EXPLAINs every `items` statement it sent with the parameters it bound. */
async function scanPartitions(
  client: PoolClient,
  fn: (recorded: PoolClient) => Promise<unknown>,
): Promise<ScanSummary> {
  const sent: RecordedStatement[] = [];
  await fn(recordItemsStatements(client, sent));
  const summary: ScanSummary = { statements: sent.length, relations: new Set(), falseFilter: false };
  for (const statement of sent) {
    const { rows } = await client.query<{ "QUERY PLAN": { Plan: PlanNode }[] }>(
      `EXPLAIN (FORMAT JSON) ${statement.text}`,
      statement.values,
    );
    const root = rows[0]?.["QUERY PLAN"][0]?.Plan;
    if (!root) throw new Error("EXPLAIN returned no plan");
    walkPlan(root, (node) => {
      const relation = node["Relation Name"];
      if (relation?.startsWith("items")) summary.relations.add(relation);
      if (node["One-Time Filter"] === "false") summary.falseFilter = true;
    });
  }
  return summary;
}

interface Fixture {
  tenantB: string;
  tenantEmpty: string;
  dbZero: string;
  dbB: string;
  projectB: string;
  projectZero: string;
  liveMailboxB: string;
  deletedMailboxB: string;
  liveMailboxZero: string;
  referencedBlobB: string;
  orphanBlobB: string;
  blobZero: string;
}

async function seed(client: PoolClient): Promise<Fixture> {
  await client.query("DROP INDEX IF EXISTS tenants_single_tenant_guard");
  const tenantB = await addTenant(client);
  const tenantEmpty = await addTenant(client);

  await scopeTo(client, getTenantZeroId());
  const dbZero = await createDatabase(client, { name: "Zero" });
  const liveMailboxZero = await insertItem(client, { databaseId: dbZero.id, properties: {} });
  await ensureMailAccountSyncState(client, { itemId: liveMailboxZero.id, syncMode: "imap" });
  const blobZero = await createBlob(client, { mimeType: "text/plain", byteSize: 1, storageKey: "zero/orphan" });
  const projectZero = await insertItem(client, { databaseId: dbZero.id, properties: { emailSendAutonomous: true } });

  await scopeTo(client, tenantB);
  const dbB = await createDatabase(client, { name: "B" });
  const projectB = await insertItem(client, { databaseId: dbB.id, properties: { emailSendAutonomous: true } });
  const liveMailboxB = await insertItem(client, { databaseId: dbB.id, properties: {} });
  await ensureMailAccountSyncState(client, { itemId: liveMailboxB.id, syncMode: "imap" });
  const deletedMailboxB = await insertItem(client, { databaseId: dbB.id, properties: {} });
  await ensureMailAccountSyncState(client, { itemId: deletedMailboxB.id, syncMode: "imap" });
  await softDeleteItem(client, dbB.id, deletedMailboxB.id);

  const referencedBlobB = await createBlob(client, { mimeType: "text/plain", byteSize: 1, storageKey: "b/referenced" });
  await insertItem(client, {
    databaseId: dbB.id,
    properties: { file: { blobId: referencedBlobB.id } },
  });
  const orphanBlobB = await createBlob(client, { mimeType: "text/plain", byteSize: 1, storageKey: "b/orphan" });

  return {
    tenantB,
    tenantEmpty,
    dbZero: dbZero.id,
    dbB: dbB.id,
    projectB: projectB.id,
    projectZero: projectZero.id,
    liveMailboxB: liveMailboxB.id,
    deletedMailboxB: deletedMailboxB.id,
    liveMailboxZero: liveMailboxZero.id,
    referencedBlobB: referencedBlobB.id,
    orphanBlobB: orphanBlobB.id,
    blobZero: blobZero.id,
  };
}

/** Seeds tenant B's curated view: members at positions 0-3, the one at position 1 trashed. */
async function seedCuratedViewB(client: PoolClient, fx: Fixture): Promise<{ viewId: string; members: string[] }> {
  await scopeTo(client, fx.tenantB);
  const view = await createView(
    client,
    { type: "list", name: "B's collection", config: { membership: "manual" } },
    createViewTypeRegistry(),
  );
  const members: string[] = [];
  for (let position = 0; position < 4; position += 1) {
    const item = await insertItem(client, { databaseId: fx.dbB, properties: {} });
    await addViewItem(client, view.id, item.id, position);
    members.push(item.id);
  }
  const trashed = members[1];
  if (!trashed) throw new Error("curated view member was not created");
  await softDeleteItem(client, fx.dbB, trashed);
  return { viewId: view.id, members };
}

interface ImapFlagFixture {
  folderRelationDefinitionId: string;
  mailboxFolderRelationDefinitionId: string;
  emailItemId: string;
}

/** Seeds tenant B's email in folder `INBOX` (uid 7) of its live mailbox, with a pending `read` write. */
async function seedPendingImapFlagWriteB(client: PoolClient, fx: Fixture): Promise<ImapFlagFixture> {
  await scopeTo(client, fx.tenantB);
  const emailFolderProperty = await createProperty(client, {
    databaseId: fx.dbB,
    key: "folder",
    name: "Folder",
    type: "relation",
  });
  const mailboxFolderProperty = await createProperty(client, {
    databaseId: fx.dbB,
    key: "mailbox",
    name: "Mailbox",
    type: "relation",
  });
  const emailFolder = await createRelationDefinition(client, { propertyIdA: emailFolderProperty.id });
  const mailboxFolder = await createRelationDefinition(client, { propertyIdA: mailboxFolderProperty.id });
  const folder = await insertItem(client, { databaseId: fx.dbB, properties: { providerId: "INBOX" } });
  const email = await insertItem(client, { databaseId: fx.dbB, properties: {} });
  await createItemRelation(client, {
    relationDefinitionId: emailFolder.id,
    itemA: email.id,
    itemB: folder.id,
    metadata: { uid: 7 },
  });
  await createItemRelation(client, {
    relationDefinitionId: mailboxFolder.id,
    itemA: fx.liveMailboxB,
    itemB: folder.id,
  });
  await recordDesiredMailMessageFlags(client, email.id, { read: true });
  return {
    folderRelationDefinitionId: emailFolder.id,
    mailboxFolderRelationDefinitionId: mailboxFolder.id,
    emailItemId: email.id,
  };
}

/** Every call that reads `items` by id, run through the same entry point its production caller uses. */
function lookups(): Record<string, (client: PoolClient) => Promise<unknown>> {
  return {
    listLiveViewItemsAfter: (c) => listLiveViewItemsAfter(c, randomUUID(), { afterPosition: null, limit: 10 }),
    generatePermissionManifest: (c) => generatePermissionManifest(c, randomUUID()),
    deleteBlobIfUnreferenced: (c) => deleteBlobIfUnreferenced(c, randomUUID()),
    getActiveMailSyncProcessNames: (c) => getActiveMailSyncProcessNames(c),
    listPendingImapFlagWrites: (c) =>
      listPendingImapFlagWrites(c, {
        folderRelationDefinitionId: randomUUID(),
        mailboxFolderRelationDefinitionId: randomUUID(),
        mailboxItemId: randomUUID(),
      }),
    getSystemHealthReport: (c) => getSystemHealthReport(c),
  };
}

describe("the remaining id-only item lookups are pruned to the tenant's partitions", () => {
  beforeAll(async () => {
    pool = getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("plans only the scoped tenant's partitions for each of the six lookups", async () => {
    await inRolledBackTransaction(async (client) => {
      const fx = await seed(client);
      await scopeTo(client, fx.tenantB);
      await client.query("SET LOCAL ROLE semprec_data");

      for (const [name, lookup] of Object.entries(lookups())) {
        const summary = await scanPartitions(client, lookup);
        expect(summary.statements, name).toBeGreaterThan(0);
        expect(summary.relations, name).toEqual(new Set([partitionName(fx.dbB)]));
      }
    });
  });

  it("returns the scoped tenant's live mailbox sync process and no other", async () => {
    await inRolledBackTransaction(async (client) => {
      const fx = await seed(client);
      await scopeTo(client, fx.tenantB);
      await client.query("SET LOCAL ROLE semprec_data");

      expect(await getActiveMailSyncProcessNames(client)).toEqual([`mailsync:${fx.liveMailboxB}`]);
    });
  });

  it("builds the scoped tenant's permission manifest from its own project item", async () => {
    await inRolledBackTransaction(async (client) => {
      const fx = await seed(client);
      await scopeTo(client, fx.tenantB);
      await client.query("SET LOCAL ROLE semprec_data");

      const manifest = await generatePermissionManifest(client, fx.projectB);
      expect(manifest.capabilities.email.send.autonomous).toBe(true);
    });
  });

  it("pages the scoped tenant's curated view by position, skipping its trashed member", async () => {
    await inRolledBackTransaction(async (client) => {
      const fx = await seed(client);
      const { viewId, members } = await seedCuratedViewB(client, fx);
      await scopeTo(client, fx.tenantB);
      await client.query("SET LOCAL ROLE semprec_data");

      expect(await listLiveViewItemsAfter(client, viewId, { afterPosition: null, limit: 2 })).toEqual([
        { viewId, itemId: members[0], position: 0 },
        { viewId, itemId: members[2], position: 2 },
      ]);
      expect(await listLiveViewItemsAfter(client, viewId, { afterPosition: 2, limit: 2 })).toEqual([
        { viewId, itemId: members[3], position: 3 },
      ]);
    });
  });

  it("lists the scoped tenant's pending IMAP flag write for its mailbox", async () => {
    await inRolledBackTransaction(async (client) => {
      const fx = await seed(client);
      const imap = await seedPendingImapFlagWriteB(client, fx);
      await scopeTo(client, fx.tenantB);
      await client.query("SET LOCAL ROLE semprec_data");

      expect(
        await listPendingImapFlagWrites(client, {
          folderRelationDefinitionId: imap.folderRelationDefinitionId,
          mailboxFolderRelationDefinitionId: imap.mailboxFolderRelationDefinitionId,
          mailboxItemId: fx.liveMailboxB,
        }),
      ).toEqual([
        { messageItemId: imap.emailItemId, propertyKey: "read", desiredState: true, folderPath: "INBOX", uid: 7 },
      ]);
    });
  });

  it("gives default capabilities when the scoped tenant names another tenant's project item", async () => {
    await inRolledBackTransaction(async (client) => {
      const fx = await seed(client);
      await scopeTo(client, fx.tenantB);
      await client.query("SET LOCAL ROLE semprec_data");

      const manifest = await generatePermissionManifest(client, fx.projectZero);
      expect(manifest.capabilities.email.send.autonomous).toBe(false);
    });
  });

  it("keeps a blob an item in the scoped tenant references and deletes an unreferenced one", async () => {
    await inRolledBackTransaction(async (client) => {
      const fx = await seed(client);
      await scopeTo(client, fx.tenantB);
      await client.query("SET LOCAL ROLE semprec_data");

      expect(await deleteBlobIfUnreferenced(client, fx.referencedBlobB)).toBeNull();
      expect(await getBlob(client, fx.referencedBlobB)).not.toBeNull();

      expect(await deleteBlobIfUnreferenced(client, fx.orphanBlobB)).toBe("b/orphan");
      expect(await getBlob(client, fx.orphanBlobB)).toBeNull();
    });
  });

  it("keeps a blob only an item in one of the scoped tenant's archived databases references", async () => {
    await inRolledBackTransaction(async (client) => {
      const fx = await seed(client);
      await scopeTo(client, fx.tenantB);
      const archived = await createDatabase(client, { name: "B archived" });
      const blob = await createBlob(client, { mimeType: "text/plain", byteSize: 1, storageKey: "b/archived" });
      await insertItem(client, { databaseId: archived.id, properties: { file: { blobId: blob.id } } });
      await archiveDatabase(client, archived.id);
      await client.query("SET LOCAL ROLE semprec_data");

      expect(await deleteBlobIfUnreferenced(client, blob.id)).toBeNull();
      expect(await getBlob(client, blob.id)).not.toBeNull();
    });
  });

  it("keeps a blob when a database created after the visible-database read holds a referencing item", async () => {
    await inRolledBackTransaction(async (client) => {
      const fx = await seed(client);
      await scopeTo(client, fx.tenantB);
      await client.query("SET LOCAL ROLE semprec_data");

      // Lands a new database and a referencing item between `visibleDatabaseIds` and the DELETE,
      // the window a concurrent commit opens under READ COMMITTED. The owner creates them, since
      // creating a partition is DDL the runtime role may not run.
      let injected = false;
      const racing = new Proxy(client, {
        get(target, prop) {
          if (prop !== "query") return Reflect.get(target, prop, target) as unknown;
          return async (text: unknown, values?: unknown[]) => {
            const result: unknown = await (target.query as (...args: unknown[]) => Promise<unknown>)(text, values);
            if (
              !injected &&
              typeof text === "string" &&
              text.includes("array_agg(id)") &&
              text.includes("FROM databases")
            ) {
              injected = true;
              await target.query("RESET ROLE");
              const late = await createDatabase(target, { name: "B late" });
              await insertItem(target, { databaseId: late.id, properties: { file: { blobId: fx.orphanBlobB } } });
              await target.query("SET LOCAL ROLE semprec_data");
            }
            return result;
          };
        },
      });

      expect(await deleteBlobIfUnreferenced(racing, fx.orphanBlobB)).toBeNull();
      expect(injected).toBe(true);
      expect(await getBlob(client, fx.orphanBlobB)).not.toBeNull();
    });
  });

  it("never deletes another tenant's blob, which row-level security hides from the delete", async () => {
    await inRolledBackTransaction(async (client) => {
      const fx = await seed(client);
      await scopeTo(client, fx.tenantB);
      await client.query("SET LOCAL ROLE semprec_data");

      expect(await deleteBlobIfUnreferenced(client, fx.blobZero)).toBeNull();

      await scopeTo(client, getTenantZeroId());
      expect(await getBlob(client, fx.blobZero)).not.toBeNull();
    });
  });

  it("returns nothing and scans no partition for a tenant with no databases", async () => {
    await inRolledBackTransaction(async (client) => {
      const fx = await seed(client);
      await scopeTo(client, fx.tenantEmpty);
      await client.query("SET LOCAL ROLE semprec_data");

      expect(await getActiveMailSyncProcessNames(client)).toEqual([]);

      for (const [name, lookup] of Object.entries(lookups())) {
        const summary = await scanPartitions(client, lookup);
        expect(summary.relations.size, name).toBe(0);
        expect(summary.falseFilter, name).toBe(true);
      }
    });
  });
});
