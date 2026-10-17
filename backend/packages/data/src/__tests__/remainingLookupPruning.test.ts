import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createDatabase } from "../chokePoint/databasesStore.js";
import { insertItem, softDeleteItem } from "../chokePoint/itemsStore.js";
import { listLiveViewItemsAfter } from "../chokePoint/viewItemsStore.js";
import { createBlob, deleteBlobIfUnreferenced, getBlob } from "../blobs/blobsStore.js";
import { ensureMailAccountSyncState } from "../mail/mailAccountSyncStateStore.js";
import { listPendingImapFlagWrites } from "../mail/mailMessageFlagSyncStore.js";
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
    liveMailboxB: liveMailboxB.id,
    deletedMailboxB: deletedMailboxB.id,
    liveMailboxZero: liveMailboxZero.id,
    referencedBlobB: referencedBlobB.id,
    orphanBlobB: orphanBlobB.id,
    blobZero: blobZero.id,
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
