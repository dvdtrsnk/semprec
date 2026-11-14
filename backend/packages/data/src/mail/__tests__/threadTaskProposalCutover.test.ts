import "../../domainWriteHooks.js";
import { runAsSystem, runInTenant } from "@semprec/shared";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { createRelationWithClient } from "../../chokePoint/relationOps.js";
import { withTransaction } from "../../db/pool.js";
import { runTenantCutoverMigrations } from "../../db/tenantCutoverMigrations.js";
import { PROCESSING_PROPOSALS_MODULE_ID } from "../../seed/inboxPipelineKeys.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createMailThread } from "../mailMessageMetaStore.js";
import { runThreadTaskProposalCutoverMigration } from "../threadTaskProposalCutoverMigration.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let cp: ChokePoint;
let databases: Record<string, string>;

interface SchemaRow {
  id: string;
  key: string;
  type: string;
  owner: string;
  owner_process: string | null;
  name: string | null;
  config: Record<string, unknown>;
  cardinality: string | null;
  property_id_b: string | null;
}

/** The properties of Processing proposals with their relation definitions, in key order. */
async function proposalsSchema(): Promise<SchemaRow[]> {
  const { rows } = await admin.query<SchemaRow>(
    `SELECT p.id, p.key, p.type, p.owner, p.owner_process, p.name, p.config, r.cardinality, r.property_id_b
       FROM properties p LEFT JOIN relation_definitions r ON r.property_id_a = p.id
      WHERE p.database_id = $1 ORDER BY p.key`,
    [databases.processingProposals],
  );
  return rows;
}

async function schemaRow(key: string): Promise<SchemaRow> {
  const row = (await proposalsSchema()).find((candidate) => candidate.key === key);
  if (!row) throw new Error(`Processing proposals has no ${key} property`);
  return row;
}

/** The generated ids differ between a fresh seed and a cutover, so a shape compares the properties without them. */
function shapeOf(row: SchemaRow) {
  return {
    key: row.key,
    type: row.type,
    owner: row.owner,
    ownerProcess: row.owner_process,
    name: row.name,
    cardinality: row.cardinality,
    propertyIdB: row.property_id_b,
    hasRelationDefinition: "relationDefinitionId" in row.config,
    target: row.config.targetDatabaseId,
    options: row.config.options,
  };
}

async function kindOptions(): Promise<string[]> {
  const options = (await schemaRow("kind")).config.options;
  if (!Array.isArray(options)) throw new Error("The kind property has no options");
  return options.map((option: { key: string }) => option.key);
}

/** Removes `sourceThread` and its definition: the schema of a tenant that predates issue gh-2034. */
async function removeSourceThread(): Promise<void> {
  const row = await admin.query<{ id: string }>("SELECT id FROM properties WHERE database_id = $1 AND key = $2", [
    databases.processingProposals,
    "sourceThread",
  ]);
  const id = row.rows[0]?.id;
  if (!id) throw new Error("sourceThread is not seeded");
  await admin.query("DELETE FROM relation_definitions WHERE property_id_a = $1", [id]);
  const removed = await admin.query("DELETE FROM properties WHERE id = $1", [id]);
  expect(removed.rowCount).toBe(1);
}

/** Removes the `mailThread` option from `kind`: the schema of a tenant that predates issue gh-2034. */
async function removeKindOption(): Promise<void> {
  const updated = await admin.query(
    `UPDATE properties SET config = jsonb_set(config, '{options}', (config->'options') - 2)
      WHERE database_id = $1 AND key = 'kind' AND config->'options'->2->>'key' = 'mailThread'`,
    [databases.processingProposals],
  );
  expect(updated.rowCount).toBe(1);
}

const runCutovers = (reason: string) => runAsSystem(reason, () => runTenantCutoverMigrations(runtime));

describe("Processing proposals thread task schema (issue gh-2034)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime));
    cp = createChokePoint(runtime);
    const { rows } = await runInTenant(tenant, () =>
      runtime.query<{ id: string; owner_module_id: string }>("SELECT id, owner_module_id FROM databases"),
    );
    databases = Object.fromEntries(rows.map((row) => [row.owner_module_id, row.id]));
  });
  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  it("a fresh install has the mailThread kind option and the system-owned many-to-many sourceThread relation to Threads, and the cutover adds nothing there", async () => {
    expect(await kindOptions()).toEqual(["inbox", "transcript", "mailThread"]);
    expect(await schemaRow("sourceThread")).toMatchObject({
      type: "relation",
      owner: "system",
      owner_process: PROCESSING_PROPOSALS_MODULE_ID,
      name: "Source thread",
      config: { targetDatabaseId: databases.threads },
      cardinality: "many_to_many",
      property_id_b: null,
    });
    const before = await proposalsSchema();

    await runCutovers("test:thread-task-proposal-fresh");

    expect(await proposalsSchema()).toEqual(before);
  });

  it("is added to an existing tenant by the cutover with the shape of a fresh install, and a second run adds nothing", async () => {
    const fresh = (await proposalsSchema()).map(shapeOf);
    await removeSourceThread();
    await removeKindOption();
    expect(await kindOptions()).toEqual(["inbox", "transcript"]);

    await runCutovers("test:thread-task-proposal");

    expect(await kindOptions()).toEqual(["inbox", "transcript", "mailThread"]);
    expect((await proposalsSchema()).map(shapeOf)).toEqual(fresh);
    const migrated = await proposalsSchema();
    await runCutovers("test:thread-task-proposal-replay");
    expect(await proposalsSchema()).toEqual(migrated);
  });

  it("adds only the option when the property exists, and only the property when the option exists", async () => {
    await removeKindOption();
    const withProperty = await schemaRow("sourceThread");
    await runInTenant(tenant, () => runThreadTaskProposalCutoverMigration(runtime));
    expect(await kindOptions()).toEqual(["inbox", "transcript", "mailThread"]);
    expect(await schemaRow("sourceThread")).toEqual(withProperty);

    await removeSourceThread();
    const withOption = await schemaRow("kind");
    await runInTenant(tenant, () => runThreadTaskProposalCutoverMigration(runtime));
    expect(await schemaRow("kind")).toEqual(withOption);
    expect(await schemaRow("sourceThread")).toMatchObject({ type: "relation", cardinality: "many_to_many" });
  });

  it("does nothing in a tenant without a Processing proposals database", async () => {
    const empty = await createTestTenant(admin);
    await runInTenant(empty, () => runThreadTaskProposalCutoverMigration(runtime));
    const { rows } = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM properties WHERE tenant_id = $1",
      [empty],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it("does nothing in a tenant that has Threads but no Processing proposals database", async () => {
    await removeSourceThread();
    await removeKindOption();
    const before = await proposalsSchema();
    await admin.query("UPDATE databases SET owner_module_id = NULL WHERE id = $1", [databases.processingProposals]);

    await runInTenant(tenant, () => runThreadTaskProposalCutoverMigration(runtime));

    expect(await proposalsSchema()).toEqual(before);
  });

  it("does nothing in a tenant without a Threads database", async () => {
    await removeSourceThread();
    await removeKindOption();
    const before = await proposalsSchema();
    await admin.query("UPDATE databases SET owner_module_id = NULL WHERE id = $1", [databases.threads]);

    await runInTenant(tenant, () => runThreadTaskProposalCutoverMigration(runtime));

    expect(await proposalsSchema()).toEqual(before);
  });

  it("lets a migrated tenant store a mailThread card and link it to a thread", async () => {
    await removeSourceThread();
    await removeKindOption();
    await runCutovers("test:thread-task-proposal-usable");
    const sourceThread = await schemaRow("sourceThread");
    const card = await runInTenant(tenant, () =>
      withTransaction(runtime, async (client) => {
        const thread = await createMailThread(client, "Invoice");
        const { rows } = await client.query<{ item_id: string }>("SELECT item_id FROM mail_threads WHERE id = $1", [
          thread.id,
        ]);
        const threadItemId = rows[0]?.item_id;
        if (!threadItemId) throw new Error("Missing thread item");
        const created = await createItemWithClient(
          client,
          { databaseId: databases.processingProposals!, properties: { kind: "mailThread", status: "proposed" } },
          { allowedSystemKeys: ["kind", "status"] },
        );
        await createRelationWithClient(
          client,
          { relationPropertyId: sourceThread.id, callerItemId: created.id, targetItemId: threadItemId },
          { ownerProcess: PROCESSING_PROPOSALS_MODULE_ID },
        );
        return { id: created.id, threadItemId };
      }),
    );

    const edges = await runInTenant(tenant, () => cp.listItemRelations(card.id, sourceThread.id));
    expect((edges ?? []).map((edge) => edge.targetItemId)).toEqual([card.threadItemId]);
  });
});
