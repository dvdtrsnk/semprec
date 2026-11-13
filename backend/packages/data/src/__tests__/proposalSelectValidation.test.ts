import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import "../domainWriteHooks.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { createInboxItemWithClient } from "../inbox/inboxStore.js";
import { createInboxTypeWithClient } from "../inbox/inboxTypesStore.js";
import {
  assertValidProposalEnvelope,
  createSemprecTickAction,
  type ComputeSemprecProposalFn,
  type ProposalComputationResult,
} from "../inbox/inboxTickAction.js";
import { confirmProposalWithClient, reviseProposalWithClient } from "../inbox/proposalActions.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

/**
 * The item writes of confirm, wrapped so a test can see whether one was attempted. The wrapper runs the real
 * write: an unknown key at confirm is refused by this check before any write, and by the item-write check
 * (issue gh-1802) inside the write, with the same field and message, so only the call count tells them apart.
 */
vi.mock("../chokePoint/itemWrites.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../chokePoint/itemWrites.js")>();
  return {
    ...actual,
    createItemWithClient: vi.fn(actual.createItemWithClient),
    updateItemWithClient: vi.fn(actual.updateItemWithClient),
  };
});

const UNKNOWN_TAG = "neznamy";

let pool: Pool;
let inboxId: string;
let typesId: string;
let proposalsId: string;
let healthId: string;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

async function runTick(itemId: string, computeProposal: ComputeSemprecProposalFn): Promise<void> {
  const handler = createSemprecTickAction(pool, computeProposal);
  await handler(
    { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId },
    { heartbeatId: "hb", projectItemId: "proj", itemId },
  );
}

async function findProposalForItem(itemId: string) {
  return withTransaction(pool, async (client) => {
    const sourceInboxProperty = await propertiesStore.getPropertyByKey(client, proposalsId, "sourceInbox");
    const relationDefinition = await relationsStore.getRelationDefinitionByPropertyId(client, sourceInboxProperty!.id);
    const edges = await relationsStore.listRelationsForItem(client, relationDefinition!.id, itemId);
    for (const edge of edges) {
      const proposal = await itemsStore.getItemById(client, proposalsId, relationsStore.otherSide(edge, itemId));
      if (proposal && !proposal.deletedAt) return proposal;
    }
    return null;
  });
}

/** An Inbox item typed to file into Health records, ticked with the given computed properties and operations. */
async function tickHealthRecord(
  properties: Record<string, unknown>,
  operations?: ProposalComputationResult["operations"],
) {
  const type = await withTransaction(pool, (client) =>
    createInboxTypeWithClient(client, {
      inboxItemTypesDatabaseId: typesId,
      name: "Health",
      emoji: "H",
      processingMethod: "database",
      targetDatabase: "healthRecords",
    }),
  );
  const item = await withTransaction(pool, (client) =>
    createInboxItemWithClient(client, {
      inboxDatabaseId: inboxId,
      date: "2026-08-28",
      time: "09:00",
      text: "Took the evening pills",
      type: type.id,
    }),
  );
  await runTick(item.id, async () => ({ properties, ...(operations ? { operations } : {}) }));
  const card = await findProposalForItem(item.id);
  if (!card) throw new Error("The tick wrote no card");
  return card;
}

async function reviseHealth(cardId: string, properties: Record<string, unknown>) {
  return withTransaction(pool, (client) =>
    reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId, {
      message: "Fix the tags",
      entityKind: "database",
      target: healthId,
      properties,
    }),
  );
}

/** Confirms a card; the spies on the item writes count only what the confirm itself attempts. */
async function confirm(cardId: string) {
  clearWriteSpies();
  return withTransaction(pool, (client) =>
    confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId),
  );
}

function clearWriteSpies(): void {
  vi.mocked(createItemWithClient).mockClear();
  vi.mocked(updateItemWithClient).mockClear();
}

async function refusal(write: Promise<unknown>): Promise<unknown> {
  return write.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
}

async function expectRefusedOnField(write: Promise<unknown>, field: string, message?: string): Promise<void> {
  const error = await refusal(write);
  expect(error).toBeInstanceOf(ValidationError);
  expect(error).toMatchObject({ status: 400, code: "validation_failed", details: { field } });
  if (message !== undefined) expect((error as ValidationError).message).toContain(message);
}

async function healthRecordCount(): Promise<number> {
  const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [
    healthId,
  ]);
  return rows[0]?.n ?? 0;
}

async function readCard(cardId: string) {
  const card = await withTransaction(pool, (client) => itemsStore.getItemById(client, proposalsId, cardId));
  if (!card) throw new Error(`Card ${cardId} is gone`);
  return card;
}

/**
 * Stores an envelope on a card the way a catalog change after the tick leaves it: the card was proposed with a
 * valid key and the option has left the catalog since. Raw SQL because revise, the only API that rewrites the
 * envelope, now refuses an unknown key.
 */
async function storeEnvelopeProperties(cardId: string, properties: Record<string, unknown>): Promise<void> {
  await pool.query(
    "UPDATE items SET properties = jsonb_set(properties, '{proposal,properties}', $2::jsonb) WHERE id = $1",
    [cardId, JSON.stringify(properties)],
  );
}

/** Stores an operations list on a card the way `storeEnvelopeProperties` stores properties. */
async function storeEnvelopeOperations(cardId: string, operations: unknown): Promise<void> {
  await pool.query(
    "UPDATE items SET properties = jsonb_set(properties, '{proposal,operations}', $2::jsonb) WHERE id = $1",
    [cardId, JSON.stringify(operations)],
  );
}

/** A Health record the way an ingest path writes it, so a value outside the catalog can be stored on it. */
async function createStoredHealthRecord(properties: Record<string, unknown>): Promise<string> {
  const created = await withTransaction(pool, (client) =>
    createItemWithClient(client, { databaseId: healthId, properties }, { writer: { writerKind: "system" } }),
  );
  clearWriteSpies();
  return created.id;
}

beforeEach(async () => {
  clearWriteSpies();
  pool ??= getTestPool();
  await resetDatabase(pool);
  await seedSystem(pool, createViewTypeRegistry());
  inboxId = await databaseIdFor("inbox");
  typesId = await databaseIdFor("inboxItemTypes");
  proposalsId = await databaseIdFor("processingProposals");
  healthId = await databaseIdFor("healthRecords");
});

afterAll(async () => {
  await pool?.end();
});

describe("tick refuses an unknown select key in a database envelope (issue gh-1814)", () => {
  it("writes a needsClarification card for tags [neznamy] on a Health record and creates no record", async () => {
    const card = await tickHealthRecord({ name: "Evening pills", tags: [UNKNOWN_TAG] });

    expect(card.properties.status).toBe("needsClarification");
    expect(card.properties.proposal).toBeNull();
    const history = card.properties.history as Array<Record<string, unknown>>;
    expect(history).toHaveLength(1);
    expect(String(history[0]?.message)).toContain(`unknown option '${UNKNOWN_TAG}'`);
    expect(await healthRecordCount()).toBe(0);
  });

  it("writes a needsClarification card when only one of several tags is unknown", async () => {
    const card = await tickHealthRecord({ name: "Evening pills", tags: ["medication", UNKNOWN_TAG] });

    expect(card.properties.status).toBe("needsClarification");
    expect(card.properties.proposal).toBeNull();
  });

  it("writes a needsClarification card for an unknown key of a single select (type)", async () => {
    const card = await tickHealthRecord({ name: "Evening pills", type: UNKNOWN_TAG });

    expect(card.properties.status).toBe("needsClarification");
    expect(card.properties.proposal).toBeNull();
  });

  it("writes a needsClarification card for a multi_select that is not an array", async () => {
    const card = await tickHealthRecord({ name: "Evening pills", tags: "medication" });

    expect(card.properties.status).toBe("needsClarification");
  });

  it.each([
    ["a known tag", { name: "Evening pills", tags: ["medication"], type: "health" }],
    ["a null tags value", { name: "Evening pills", tags: null, type: null }],
    ["an empty tags array", { name: "Evening pills", tags: [] }],
    ["no select key at all", { name: "Evening pills" }],
  ])("proposes the envelope with %s", async (_label, properties) => {
    const card = await tickHealthRecord(properties);

    expect(card.properties.status).toBe("proposed");
    expect(card.properties.proposal).toEqual({ entityKind: "database", target: healthId, properties });
  });
});

describe("revise refuses an unknown select key in a database envelope (issue gh-1814)", () => {
  it("answers 400 with details.field tags for tags [neznamy] and leaves the card as it was", async () => {
    const card = await tickHealthRecord({ name: "Evening pills", tags: ["medication"] });

    await expectRefusedOnField(reviseHealth(card.id, { name: "Evening pills", tags: [UNKNOWN_TAG] }), "tags");

    const after = await readCard(card.id);
    expect(after.properties.proposal).toEqual(card.properties.proposal);
    expect(after.properties.history).toEqual(card.properties.history);
    expect(after.updatedAt).toBe(card.updatedAt);
  });

  it("answers 400 with details.field type for an unknown single-select key", async () => {
    const card = await tickHealthRecord({ name: "Evening pills" });

    await expectRefusedOnField(reviseHealth(card.id, { name: "Evening pills", type: UNKNOWN_TAG }), "type");
  });

  it.each([
    ["a known tag", ["medication"]],
    ["a null tags value", null],
  ])("accepts %s and stores the revised envelope", async (_label, tags) => {
    const card = await tickHealthRecord({ name: "Evening pills" });
    const properties = { name: "Evening pills", tags };

    const revised = await reviseHealth(card.id, properties);

    expect(revised.properties.status).toBe("proposed");
    expect(revised.properties.proposal).toEqual({ entityKind: "database", target: healthId, properties });
  });

  it("revises a needsClarification card to proposed once the tags are known", async () => {
    const card = await tickHealthRecord({ name: "Evening pills", tags: [UNKNOWN_TAG] });
    expect(card.properties.status).toBe("needsClarification");

    const revised = await reviseHealth(card.id, { name: "Evening pills", tags: ["medication"] });

    expect(revised.properties.status).toBe("proposed");
  });
});

describe("confirm refuses an unknown select key in a database envelope (issue gh-1814)", () => {
  it("answers 400 with details.field tags, leaves the card proposed and writes no record", async () => {
    const card = await tickHealthRecord({ name: "Evening pills", tags: ["medication"] });
    await storeEnvelopeProperties(card.id, { name: "Evening pills", tags: [UNKNOWN_TAG] });

    await expectRefusedOnField(confirm(card.id), "tags");

    const after = await readCard(card.id);
    expect(after.properties.status).toBe("proposed");
    expect(await healthRecordCount()).toBe(0);
    // Refused by the envelope check before any write; the item-write check would have refused it with the
    // same error one step later, inside a write that rolled back.
    expect(createItemWithClient).not.toHaveBeenCalled();
    expect(updateItemWithClient).not.toHaveBeenCalled();
  });

  it("answers 400 with details.field tags before the first write of a multi-step envelope", async () => {
    const card = await tickHealthRecord({ name: "Evening pills", tags: ["medication"] }, [
      { op: "create", database: "healthRecords", properties: { name: "Evening pills", tags: ["medication"] } },
      { op: "create", database: "healthRecords", properties: { name: "Second pills", tags: ["medication"] } },
    ]);
    const stored = (await readCard(card.id)).properties.proposal as { operations: Array<Record<string, unknown>> };
    expect(stored.operations).toHaveLength(2);
    await storeEnvelopeOperations(
      card.id,
      stored.operations.map((step, index) =>
        index === 1 ? { ...step, properties: { name: "Second pills", tags: [UNKNOWN_TAG] } } : step,
      ),
    );

    await expectRefusedOnField(confirm(card.id), "tags");

    expect((await readCard(card.id)).properties.status).toBe("proposed");
    expect(createItemWithClient).not.toHaveBeenCalled();
  });

  it("confirms an envelope with tags [medication] into a Health record", async () => {
    const card = await tickHealthRecord({ name: "Evening pills", tags: ["medication"] });

    const confirmed = await confirm(card.id);

    expect(confirmed.properties.status).toBe("confirmed");
    const { rows } = await pool.query<{ properties: Record<string, unknown> }>(
      "SELECT properties FROM items WHERE database_id = $1",
      [healthId],
    );
    expect(rows.map((row) => row.properties.tags)).toEqual([["medication"]]);
    expect(createItemWithClient).toHaveBeenCalledTimes(1);
  });

  it("confirms an envelope with null tags into a Health record", async () => {
    const card = await tickHealthRecord({ name: "Evening pills", tags: null });

    const confirmed = await confirm(card.id);

    expect(confirmed.properties.status).toBe("confirmed");
    expect(await healthRecordCount()).toBe(1);
  });
});

describe("assertValidProposalEnvelope and the option catalog (issue gh-1814)", () => {
  function validate(envelope: Parameters<typeof assertValidProposalEnvelope>[1]) {
    return withTransaction(pool, (client) => assertValidProposalEnvelope(client, envelope));
  }

  it("refuses tags [neznamy] with details.field tags", async () => {
    await expectRefusedOnField(
      validate({ entityKind: "database", target: healthId, properties: { name: "x", tags: [UNKNOWN_TAG] } }),
      "tags",
    );
  });

  it("reads the options of a tenant database's own select and multi_select properties", async () => {
    const own = await createChokePoint(pool).createDatabaseWithProperties({ name: "Own database" }, "Name", [
      { key: "choice", name: "Choice", type: "select", config: { options: [{ key: "one" }] } },
      { key: "many", name: "Many", type: "multi_select", config: { options: [{ key: "two" }] } },
    ]);
    const envelope = (properties: Record<string, unknown>) => ({
      entityKind: "database" as const,
      target: own.id,
      properties: { name: "Row", ...properties },
    });

    expect((await validate(envelope({ choice: "one", many: ["two"] })))?.id).toBe(own.id);
    await expectRefusedOnField(validate(envelope({ choice: "two" })), "choice");
    await expectRefusedOnField(validate(envelope({ many: ["one"] })), "many");
  });

  it("leaves an envelope for a database without select properties unchanged", async () => {
    const own = await createChokePoint(pool).createDatabaseWithProperties({ name: "Plain database" }, "Name", [
      { key: "note", name: "Note", type: "text" },
    ]);

    const resolved = await validate({
      entityKind: "database",
      target: own.id,
      properties: { name: "Row", note: "free text" },
    });

    expect(resolved?.id).toBe(own.id);
  });

  it("does not look at select values of a pageContent envelope", async () => {
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Thought",
        emoji: "T",
        processingMethod: "pageContent",
      }),
    );

    const resolved = await validate({
      entityKind: "pageContent",
      target: type.id,
      properties: { flavour: "paragraph", tags: [UNKNOWN_TAG] },
    });

    expect(resolved).toBeNull();
  });
});

describe("the steps of a multi-step envelope and the option catalog (issue gh-1814)", () => {
  function validate(envelope: Parameters<typeof assertValidProposalEnvelope>[1]) {
    return withTransaction(pool, (client) => assertValidProposalEnvelope(client, envelope));
  }

  type Step = NonNullable<Parameters<typeof assertValidProposalEnvelope>[1]["operations"]>[number];
  const createStep = (ref: string, role: Step["role"], properties: Record<string, unknown>): Step => ({
    ref,
    op: "create",
    databaseKey: "healthRecords",
    role,
    properties,
  });
  /** An update step as the tick forms it: `before` holds the item's current values, `after` the new ones. */
  const updateStep = (
    ref: string,
    role: Step["role"],
    itemId: string,
    properties: Record<string, unknown>,
    before: Record<string, unknown> = {},
  ): Step => ({
    ref,
    op: "update",
    itemId,
    role,
    properties,
    before: { properties: before },
    after: { properties },
  });
  const envelopeOf = (primary: Step, ...rest: Step[]) => ({
    entityKind: "database" as const,
    target: healthId,
    properties: primary.properties ?? {},
    operations: [primary, ...rest],
  });

  it("refuses an unknown tag on a secondary create step, naming the step and the property", async () => {
    const primary = createStep("record", "primary", { name: "Evening pills", tags: ["medication"] });
    const secondary = createStep("second", "secondary", { name: "Second pills", tags: [UNKNOWN_TAG] });

    const error = await refusal(validate(envelopeOf(primary, secondary)));

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ status: 400, details: { ref: "second", field: "tags" } });
    expect((await validate(envelopeOf(primary, createStep("second", "secondary", { name: "Second pills" }))))?.id).toBe(
      healthId,
    );
  });

  it("refuses an unknown tag on a secondary update step", async () => {
    const record = await createStoredHealthRecord({ name: "Old record", tags: ["medication"] });
    const primary = createStep("record", "primary", { name: "Evening pills" });

    await expectRefusedOnField(
      validate(
        envelopeOf(primary, updateStep("fix", "secondary", record, { tags: [UNKNOWN_TAG] }, { tags: ["medication"] })),
      ),
      "tags",
      `unknown option '${UNKNOWN_TAG}'`,
    );
    expect(
      (
        await validate(
          envelopeOf(
            primary,
            updateStep("fix", "secondary", record, { tags: ["medication"] }, { tags: ["medication"] }),
          ),
        )
      )?.id,
    ).toBe(healthId);
  });

  it("accepts an update step that keeps a value the item already holds although it left the catalog", async () => {
    const record = await createStoredHealthRecord({ name: "Old record", tags: ["gone"] });
    const primary = createStep("record", "primary", { name: "Evening pills" });
    const keep = updateStep(
      "keep",
      "secondary",
      record,
      { name: "Renamed", tags: ["gone"] },
      { name: "Old record", tags: ["gone"] },
    );

    expect((await validate(envelopeOf(primary, keep)))?.id).toBe(healthId);
    await expectRefusedOnField(
      validate(
        envelopeOf(
          primary,
          updateStep("keep", "secondary", record, { tags: ["gone", UNKNOWN_TAG] }, { tags: ["gone"] }),
        ),
      ),
      "tags",
      "unknown option '",
    );
  });

  it("accepts a primary update step that keeps a stored value outside the catalog, and refuses a new one", async () => {
    const record = await createStoredHealthRecord({ name: "Old record", tags: ["gone"] });

    const kept = { name: "Renamed", tags: ["gone"] };
    expect(
      (
        await validate(
          envelopeOf(updateStep("record", "primary", record, kept, { name: "Old record", tags: ["gone"] })),
        )
      )?.id,
    ).toBe(healthId);
    await expectRefusedOnField(
      validate(
        envelopeOf(
          updateStep("record", "primary", record, { tags: [UNKNOWN_TAG] }, { name: "Old record", tags: ["gone"] }),
        ),
      ),
      "tags",
      `unknown option '${UNKNOWN_TAG}'`,
    );
  });

  it("writes a needsClarification card at tick when a secondary step names an unknown tag", async () => {
    const card = await tickHealthRecord({ name: "Evening pills", tags: ["medication"] }, [
      { op: "create", database: "healthRecords", properties: { name: "Evening pills", tags: ["medication"] } },
      { op: "create", database: "healthRecords", properties: { name: "Second pills", tags: [UNKNOWN_TAG] } },
    ]);

    expect(card.properties.status).toBe("needsClarification");
    expect(card.properties.proposal).toBeNull();
    expect(await healthRecordCount()).toBe(0);
  });

  it("proposes a multi-step envelope whose steps all name known tags", async () => {
    const card = await tickHealthRecord({ name: "Evening pills", tags: ["medication"] }, [
      { op: "create", database: "healthRecords", properties: { name: "Evening pills", tags: ["medication"] } },
      { op: "create", database: "healthRecords", properties: { name: "Second pills", tags: ["medication"] } },
    ]);

    expect(card.properties.status).toBe("proposed");
  });
});

describe("assertValidProposalEnvelope through the runtime role (issue gh-1814)", () => {
  it("refuses an unknown tag in a tenant other than tenant zero, with row-level security in force", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    try {
      const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      const tenant = await createTestTenant(pool);
      await runInTenant(tenant, () => seedSystem(runtime, createViewTypeRegistry()));
      const health = await runInTenant(tenant, () =>
        withTransaction(runtime, (client) => databasesStore.getDatabaseByModuleId(client, "healthRecords")),
      );
      if (!health) throw new Error("The tenant has no Health records database");
      const validate = (tags: unknown) =>
        runInTenant(tenant, () =>
          withTransaction(runtime, (client) =>
            assertValidProposalEnvelope(client, {
              entityKind: "database",
              target: health.id,
              properties: { name: "x", tags },
            }),
          ),
        );

      await expectRefusedOnField(validate([UNKNOWN_TAG]), "tags");
      expect((await validate(["medication"]))?.id).toBe(health.id);
    } finally {
      await runtime.end();
    }
  });
});
