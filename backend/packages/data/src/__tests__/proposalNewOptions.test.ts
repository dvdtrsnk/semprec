import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import "../domainWriteHooks.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { OptionLabelExistsError, ValidationError } from "../errors.js";
import { createInboxItemWithClient } from "../inbox/inboxStore.js";
import {
  assertValidProposalEnvelope,
  createSemprecTickAction,
  MAX_PROPOSAL_NEW_OPTIONS,
  parseStoredProposalEnvelope,
  storedEnvelopeStillValid,
  type ProposalComputationResult,
  type ProposalEnvelope,
} from "../inbox/inboxTickAction.js";
import { createInboxTypeWithClient } from "../inbox/inboxTypesStore.js";
import {
  confirmProposalWithClient,
  rejectProposalWithClient,
  reopenProposalWithClient,
  reviseProposalFromThreadWithClient,
  reviseProposalWithClient,
  updateProposalValuesWithClient,
} from "../inbox/proposalActions.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import { seedSystem } from "../seed/seedSystem.js";
import type { ItemRow } from "../types.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";

/**
 * The item writes of confirm, wrapped so one test can make the item create of the confirm fail after the options were
 * added. Every other call runs the real write.
 */
vi.mock("../chokePoint/itemWrites.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../chokePoint/itemWrites.js")>();
  return { ...actual, createItemWithClient: vi.fn(actual.createItemWithClient) };
});

const invalidation = vi.fn<(event: InvalidationEvent) => void>();

/** The schema invalidations sent since the last reset: the item invalidations of the writes around them are not counted. */
function schemaInvalidations(): InvalidationEvent[] {
  return invalidation.mock.calls.map(([event]) => event).filter((event) => event.scope === "schema");
}

let admin: Pool;
let runtime: Pool;
let tenant: string;
let other: string;

interface Fixture {
  inbox: string;
  types: string;
  proposals: string;
  healthRecords: string;
  /** The `tags` multi_select and the `type` select of Health records. */
  tags: string;
  type: string;
}

const optionRowsSchema = z.object({
  options: z.array(z.object({ key: z.string(), label: z.string().optional(), color: z.string().optional() })),
});

/** The ids of the tenant's databases and the two select properties this test reads, resolved as that tenant. */
async function loadFixture(tenantId: string): Promise<Fixture> {
  return runInTenant(tenantId, () =>
    withTransaction(runtime, async (client) => {
      const database = async (moduleId: string): Promise<string> => {
        const row = await getDatabaseByModuleId(client, moduleId);
        if (!row) throw new Error(`Database '${moduleId}' was not seeded`);
        return row.id;
      };
      const healthRecords = await database("healthRecords");
      const property = async (key: string): Promise<string> => {
        const row = await propertiesStore.getPropertyByKey(client, healthRecords, key);
        if (!row) throw new Error(`Property '${key}' was not seeded`);
        return row.id;
      };
      return {
        inbox: await database("inbox"),
        types: await database("inboxItemTypes"),
        proposals: await database("processingProposals"),
        healthRecords,
        tags: await property("tags"),
        type: await property("type"),
      };
    }),
  );
}

let ids: Fixture;
let foreign: Fixture;

const NEW_TAG = { propertyKey: "tags", label: "Bylinky" };
const NEW_TAG_VALUE = { newOption: "Bylinky" };

/** What the computation answers for a health note whose tag is new: the record, the tag by label, and the option. */
function herbsAnswer(overrides: Partial<ProposalComputationResult> = {}): ProposalComputationResult {
  return {
    properties: { name: "Herbal tea against a cold", tags: [NEW_TAG_VALUE] },
    newOptions: [NEW_TAG],
    ...overrides,
  };
}

/**
 * A proposal card for a health note through the production path: an active Inbox type that targets Health records,
 * an Inbox item of that type and one tick whose computation answers `result`, so the card holds the envelope exactly
 * as the tick validated and stored it.
 */
async function createHealthCard(
  tenantId: string,
  fixture: Fixture,
  result: ProposalComputationResult,
): Promise<ItemRow> {
  return runInTenant(tenantId, async () => {
    const type = await withTransaction(runtime, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: fixture.types,
        name: "Health note",
        emoji: "H",
        processingMethod: "database",
        targetDatabase: "healthRecords",
      }),
    );
    const item = await withTransaction(runtime, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: fixture.inbox,
        date: "2026-10-16",
        time: "09:00",
        text: "Herbal tea against a cold",
        type: type.id,
      }),
    );
    await createSemprecTickAction(runtime, async () => result)(
      {
        inboxDatabaseId: fixture.inbox,
        inboxItemTypesDatabaseId: fixture.types,
        processingProposalsDatabaseId: fixture.proposals,
      },
      { heartbeatId: "hb", projectItemId: "proj", itemId: item.id },
    );
    return withTransaction(runtime, async (client) => {
      const sourceInbox = await propertiesStore.getPropertyByKey(client, fixture.proposals, "sourceInbox");
      if (!sourceInbox) throw new Error("The proposals database has no sourceInbox property");
      const definition = await relationsStore.getRelationDefinitionByPropertyId(client, sourceInbox.id);
      if (!definition) throw new Error("The sourceInbox property has no relation definition");
      const [edge] = await relationsStore.listRelationsForItem(client, definition.id, item.id);
      if (!edge) throw new Error("The tick stored no proposal card");
      const card = await itemsStore.getItemById(client, fixture.proposals, relationsStore.otherSide(edge, item.id));
      if (!card) throw new Error("The proposal card is missing");
      return card;
    });
  });
}

function storedEnvelope(card: ItemRow): ProposalEnvelope {
  const envelope = parseStoredProposalEnvelope(card.properties.proposal, card.id);
  if (!envelope || "unknownKind" in envelope) throw new Error("The card holds no computed envelope");
  return envelope;
}

function config(fixture: Fixture) {
  return { processingProposalsDatabaseId: fixture.proposals };
}

function confirmWithClient(client: PoolClient, fixture: Fixture, cardId: string): Promise<ItemRow> {
  return confirmProposalWithClient(client, config(fixture), cardId);
}

function confirm(tenantId: string, fixture: Fixture, cardId: string): Promise<ItemRow> {
  return runInTenant(tenantId, () => withTransaction(runtime, (client) => confirmWithClient(client, fixture, cardId)));
}

/** The options of one select property of the tenant's Health records, in stored order, read on a connection of their own. */
async function optionsOf(
  tenantId: string,
  propertyId: string,
): Promise<Array<z.infer<typeof optionRowsSchema>["options"][number]>> {
  return runInTenant(tenantId, async () => {
    const { rows } = await runtime.query<{ config: unknown }>("SELECT config FROM properties WHERE id = $1", [
      propertyId,
    ]);
    return optionRowsSchema.parse(rows[0]?.config).options;
  });
}

async function optionKeys(tenantId: string, propertyId: string): Promise<string[]> {
  return (await optionsOf(tenantId, propertyId)).map((option) => option.key);
}

/** The live Health records of a tenant, read on a connection of their own. */
async function healthRecords(tenantId: string, fixture: Fixture): Promise<ItemRow[]> {
  const page = await runInTenant(tenantId, () =>
    createChokePoint(runtime).queryDatabaseItems(fixture.healthRecords, {}),
  );
  return page.items;
}

async function cardStatus(tenantId: string, fixture: Fixture, cardId: string): Promise<unknown> {
  const card = await runInTenant(tenantId, () =>
    withTransaction(runtime, (client) => itemsStore.getItemById(client, fixture.proposals, cardId)),
  );
  return card?.properties.status;
}

/** Adds an option through the choke point, as a person would, so a label is taken after a card was computed. */
async function addOption(tenantId: string, propertyId: string, label: string): Promise<void> {
  await runInTenant(tenantId, () => createChokePoint(runtime).addPropertyOption(propertyId, { label }));
}

function validate(envelope: ProposalEnvelope) {
  return runInTenant(tenant, () => withTransaction(runtime, (client) => assertValidProposalEnvelope(client, envelope)));
}

async function refusal(write: Promise<unknown>): Promise<unknown> {
  return write.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
}

async function expectRefusedOnField(write: Promise<unknown>, field: string, reason?: string): Promise<void> {
  const error = await refusal(write);
  expect(error).toBeInstanceOf(ValidationError);
  expect(error).toMatchObject({ status: 400, code: "validation_failed", details: { field } });
  if (reason !== undefined) expect(error).toMatchObject({ details: { reason } });
}

function envelopeOf(properties: Record<string, unknown>, extra: Partial<ProposalEnvelope> = {}): ProposalEnvelope {
  return { entityKind: "database", target: ids.healthRecords, properties: { name: "Row", ...properties }, ...extra };
}

beforeAll(async () => {
  admin = getTestPool();
  runtime = await createRuntimeRolePool(admin, "semprec_data");
  const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
  );
  expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
});

beforeEach(async () => {
  vi.mocked(createItemWithClient).mockClear();
  await resetDatabase(admin);
  tenant = getTenantZeroId();
  other = await createTestTenant(admin);
  for (const tenantId of [tenant, other]) {
    await runInTenant(tenantId, () => seedSystem(runtime, createViewTypeRegistry()));
  }
  ids = await loadFixture(tenant);
  foreign = await loadFixture(other);
});

beforeEach(() => {
  invalidation.mockClear();
  setInvalidationHook(invalidation);
});

afterEach(() => setInvalidationHook(() => {}));

afterAll(async () => {
  await runtime.end();
  await admin.end();
});

describe("assertValidProposalEnvelope and the new options of an envelope (issue gh-1994)", () => {
  it("accepts a multi_select value that names a listed new option and leaves the schema as it was", async () => {
    const before = await optionKeys(tenant, ids.tags);

    const target = await validate(envelopeOf({ tags: [NEW_TAG_VALUE] }, { newOptions: [NEW_TAG] }));

    expect(target?.id).toBe(ids.healthRecords);
    expect(await optionKeys(tenant, ids.tags)).toEqual(before);
  });

  it("accepts a select value that names a listed new option", async () => {
    const target = await validate(
      envelopeOf({ type: { newOption: "Dentist" } }, { newOptions: [{ propertyKey: "type", label: "Dentist" }] }),
    );

    expect(target?.id).toBe(ids.healthRecords);
  });

  it("accepts a new option mixed with listed keys, and refuses an unknown key next to it", async () => {
    const newOptions = [NEW_TAG];

    expect((await validate(envelopeOf({ tags: ["medication", NEW_TAG_VALUE] }, { newOptions })))?.id).toBe(
      ids.healthRecords,
    );
    await expectRefusedOnField(validate(envelopeOf({ tags: ["neznamy", NEW_TAG_VALUE] }, { newOptions })), "tags");
  });

  it("matches the label of the value to the listed one after trimming both", async () => {
    const target = await validate(
      envelopeOf({ tags: [{ newOption: " Bylinky " }] }, { newOptions: [{ propertyKey: "tags", label: "Bylinky  " }] }),
    );

    expect(target?.id).toBe(ids.healthRecords);
  });

  it("accepts a listed option that no value uses", async () => {
    const target = await validate(envelopeOf({ tags: ["medication"] }, { newOptions: [NEW_TAG] }));

    expect(target?.id).toBe(ids.healthRecords);
  });

  it("accepts the most new options the limit allows", async () => {
    const newOptions = ["One", "Two", "Three"].map((label) => ({ propertyKey: "tags", label }));
    expect(newOptions).toHaveLength(MAX_PROPOSAL_NEW_OPTIONS);

    const target = await validate(
      envelopeOf({ tags: newOptions.map(({ label }) => ({ newOption: label })) }, { newOptions }),
    );

    expect(target?.id).toBe(ids.healthRecords);
  });

  it("refuses four new options with the new_option_limit reason", async () => {
    const newOptions = ["One", "Two", "Three", "Four"].map((label) => ({ propertyKey: "tags", label }));

    await expectRefusedOnField(
      validate(envelopeOf({ tags: [{ newOption: "One" }] }, { newOptions })),
      "newOptions",
      "new_option_limit",
    );
  });

  it.each([
    ["léky", "the Czech label of the shipped option medication"],
    ["Medication", "the English label of the shipped option medication"],
    ["  LÉKY ", "the Czech label in another case, with surrounding whitespace"],
  ])("refuses the label %s as option_label_exists naming the existing key (%s)", async (label) => {
    const error = await refusal(
      validate(envelopeOf({ tags: [{ newOption: label }] }, { newOptions: [{ propertyKey: "tags", label }] })),
    );

    expect(error).toBeInstanceOf(OptionLabelExistsError);
    expect(error).toMatchObject({ status: 409, code: "option_label_exists", details: { key: "medication" } });
  });

  it("refuses a label that an option added by a person already has, by its stored label", async () => {
    await addOption(tenant, ids.tags, "Bylinky");

    const error = await refusal(validate(envelopeOf({ tags: [NEW_TAG_VALUE] }, { newOptions: [NEW_TAG] })));

    expect(error).toBeInstanceOf(OptionLabelExistsError);
    expect(error).toMatchObject({ code: "option_label_exists", details: { key: "bylinky" } });
  });

  it("does not check the label of a listed option that no value names, and still refuses one that a value names", async () => {
    const taken = { propertyKey: "tags", label: "léky" };

    await expect(validate(envelopeOf({ tags: ["medication"] }, { newOptions: [taken] }))).resolves.not.toBeNull();
    await expect(
      validate(envelopeOf({ tags: [{ newOption: "léky" }] }, { newOptions: [taken] })),
    ).rejects.toBeInstanceOf(OptionLabelExistsError);
  });

  it.each([
    ["an empty label", { propertyKey: "tags", label: "" }],
    ["a label of only whitespace", { propertyKey: "tags", label: "   " }],
    ["a label of 61 characters", { propertyKey: "tags", label: "x".repeat(61) }],
    ["a color that is not #RRGGBB", { propertyKey: "tags", label: "Bylinky", color: "green" }],
  ])("refuses %s on newOptions", async (_name, option) => {
    await expectRefusedOnField(
      validate(envelopeOf({ tags: [{ newOption: option.label }] }, { newOptions: [option] })),
      "newOptions",
    );
  });

  it("accepts a label of 60 characters and a #RRGGBB color", async () => {
    const label = "x".repeat(60);

    const target = await validate(
      envelopeOf({ tags: [{ newOption: label }] }, { newOptions: [{ propertyKey: "tags", label, color: "#00ff00" }] }),
    );

    expect(target?.id).toBe(ids.healthRecords);
  });

  it.each([
    ["an unknown property", "nothing"],
    ["a property that is not a select", "name"],
  ])("refuses a new option on %s", async (_name, propertyKey) => {
    await expectRefusedOnField(
      validate(envelopeOf({ tags: [NEW_TAG_VALUE] }, { newOptions: [{ propertyKey, label: "Bylinky" }] })),
      "newOptions",
    );
  });

  it("refuses the same label twice for one property, whatever its case", async () => {
    await expectRefusedOnField(
      validate(
        envelopeOf({ tags: [NEW_TAG_VALUE] }, { newOptions: [NEW_TAG, { propertyKey: "tags", label: "BYLINKY" }] }),
      ),
      "newOptions",
    );
  });

  it("accepts the same label on two different properties", async () => {
    const target = await validate(
      envelopeOf(
        { tags: [{ newOption: "Other" }], type: { newOption: "Other" } },
        {
          newOptions: [
            { propertyKey: "tags", label: "Other" },
            { propertyKey: "type", label: "Other" },
          ],
        },
      ),
    );

    expect(target?.id).toBe(ids.healthRecords);
  });

  it.each([
    ["no newOptions at all", undefined],
    ["a newOptions list that names the label for another property", [{ propertyKey: "type", label: "Bylinky" }]],
    ["a newOptions list that names another label", [{ propertyKey: "tags", label: "Houby" }]],
  ])("refuses a value of a new option that newOptions does not list: %s", async (_name, newOptions) => {
    await expectRefusedOnField(
      validate(envelopeOf({ tags: [NEW_TAG_VALUE] }, newOptions ? { newOptions } : {})),
      "tags",
    );
  });

  it("refuses a { newOption } value of a select that newOptions does not list", async () => {
    await expectRefusedOnField(validate(envelopeOf({ type: { newOption: "Dentist" } })), "type");
  });

  it("refuses newOptions on a multi-step envelope", async () => {
    const step = {
      ref: "record",
      op: "create" as const,
      databaseKey: "healthRecords",
      role: "primary" as const,
      properties: { name: "Row", tags: ["medication"] },
    };

    await expectRefusedOnField(
      validate({
        entityKind: "database",
        target: ids.healthRecords,
        properties: step.properties,
        operations: [step],
        newOptions: [NEW_TAG],
      }),
      "newOptions",
    );
  });

  it("refuses newOptions on an envelope that is not a database one", async () => {
    await expectRefusedOnField(
      validate({
        entityKind: "pageContent",
        target: ids.healthRecords,
        properties: { flavour: "paragraph" },
        newOptions: [NEW_TAG],
      }),
      "newOptions",
    );
  });

  it("handles an envelope without newOptions as before: a known key passes and an unknown one is refused", async () => {
    expect((await validate(envelopeOf({ tags: ["medication"], type: "health" })))?.id).toBe(ids.healthRecords);
    await expectRefusedOnField(validate(envelopeOf({ tags: ["neznamy"] })), "tags");
  });

  it("answers another tenant's database as it answers an unknown property", async () => {
    // The target is the other tenant's Health records, which this tenant cannot see: no select property resolves.
    const error = await refusal(
      runInTenant(tenant, () =>
        withTransaction(runtime, (client) =>
          assertValidProposalEnvelope(client, {
            entityKind: "database",
            target: foreign.healthRecords,
            properties: { name: "Row", tags: [NEW_TAG_VALUE] },
            newOptions: [NEW_TAG],
          }),
        ),
      ),
    );

    expect(error).toBeInstanceOf(ValidationError);
    expect(await optionKeys(other, foreign.tags)).not.toContain("bylinky");
  });
});

describe("the tick and the new options of a computed answer (issue gh-1994)", () => {
  it("stores a proposed card that carries newOptions and the label value, and creates no option", async () => {
    const before = await optionKeys(tenant, ids.tags);

    const card = await createHealthCard(tenant, ids, herbsAnswer());

    expect(card.properties.status).toBe("proposed");
    expect(card.properties.proposal).toEqual({
      entityKind: "database",
      target: ids.healthRecords,
      properties: { name: "Herbal tea against a cold", tags: [NEW_TAG_VALUE] },
      newOptions: [NEW_TAG],
    });
    expect(await optionKeys(tenant, ids.tags)).toEqual(before);
    expect(await healthRecords(tenant, ids)).toEqual([]);
  });

  it("stores an answer without newOptions as it did before, with no newOptions field", async () => {
    const card = await createHealthCard(tenant, ids, { properties: { name: "Evening pills", tags: ["medication"] } });

    expect(card.properties.status).toBe("proposed");
    expect(card.properties.proposal).toEqual({
      entityKind: "database",
      target: ids.healthRecords,
      properties: { name: "Evening pills", tags: ["medication"] },
    });
  });

  it("stores an answer with an empty newOptions list without the field", async () => {
    const card = await createHealthCard(tenant, ids, {
      properties: { name: "Evening pills", tags: ["medication"] },
      newOptions: [],
    });

    expect(card.properties.status).toBe("proposed");
    expect(storedEnvelope(card).newOptions).toBeUndefined();
  });

  it("writes a needsClarification card for a label an option already has, and does not fail the tick", async () => {
    const card = await createHealthCard(
      tenant,
      ids,
      herbsAnswer({
        properties: { name: "Evening pills", tags: [{ newOption: "léky" }] },
        newOptions: [{ propertyKey: "tags", label: "léky" }],
      }),
    );

    expect(card.properties.status).toBe("needsClarification");
    expect(card.properties.proposal).toBeNull();
    expect(await optionKeys(tenant, ids.tags)).not.toContain("leky");
  });

  it("writes a needsClarification card for four new options", async () => {
    const newOptions = ["One", "Two", "Three", "Four"].map((label) => ({ propertyKey: "tags", label }));

    const card = await createHealthCard(
      tenant,
      ids,
      herbsAnswer({ properties: { name: "Evening pills", tags: [{ newOption: "One" }] }, newOptions }),
    );

    expect(card.properties.status).toBe("needsClarification");
    expect(await optionKeys(tenant, ids.tags)).not.toContain("one");
  });

  it("judges a stored card by its new options: valid while the label is free, not valid once an option took it", async () => {
    const card = await createHealthCard(tenant, ids, herbsAnswer());
    const stillValid = () =>
      runInTenant(tenant, () => withTransaction(runtime, (client) => storedEnvelopeStillValid(client, card)));

    expect(await stillValid()).toBe(true);

    await addOption(tenant, ids.tags, "Bylinky");

    expect(await stillValid()).toBe(false);
  });
});

describe("confirming a proposal that carries new options (issue gh-1994)", () => {
  it("creates the option and the health record that carries its key", async () => {
    const card = await createHealthCard(tenant, ids, herbsAnswer());
    const before = await optionKeys(tenant, ids.tags);

    const confirmed = await confirm(tenant, ids, card.id);

    expect(confirmed.properties.status).toBe("confirmed");
    expect(await optionsOf(tenant, ids.tags)).toEqual([
      ...before.map((key) => expect.objectContaining({ key })),
      { key: "bylinky", label: "Bylinky" },
    ]);
    const records = await healthRecords(tenant, ids);
    expect(records.map((record) => record.id)).toEqual([confirmed.properties.resultItemId]);
    expect(records[0]?.properties).toMatchObject({ name: "Herbal tea against a cold", tags: ["bylinky"] });
  });

  it("sends the schema invalidation of Health records once, after the commit, and none when the confirm rolls back", async () => {
    const card = await createHealthCard(tenant, ids, herbsAnswer());
    const failure = new Error("roll the confirmation back");
    invalidation.mockClear();

    await expect(
      runInTenant(tenant, () =>
        withTransaction(runtime, async (client) => {
          await confirmWithClient(client, ids, card.id);
          // Nothing has been sent while the transaction is open.
          expect(schemaInvalidations()).toEqual([]);
          throw failure;
        }),
      ),
    ).rejects.toBe(failure);
    expect(schemaInvalidations()).toEqual([]);

    await confirm(tenant, ids, card.id);

    expect(schemaInvalidations()).toEqual([{ scope: "schema", databaseId: ids.healthRecords, userId: undefined }]);
  });

  it("keeps the listed keys next to the new one, stores the color in upper case and creates a select option", async () => {
    const card = await createHealthCard(tenant, ids, {
      properties: { name: "Dentist visit", tags: ["prevention", NEW_TAG_VALUE], type: { newOption: "Dentistry" } },
      newOptions: [
        { ...NEW_TAG, color: "#00ff00" },
        { propertyKey: "type", label: "Dentistry" },
      ],
    });

    await confirm(tenant, ids, card.id);

    expect((await optionsOf(tenant, ids.tags)).at(-1)).toEqual({ key: "bylinky", label: "Bylinky", color: "#00FF00" });
    expect((await optionsOf(tenant, ids.type)).at(-1)).toEqual({ key: "dentistry", label: "Dentistry" });
    const [record] = await healthRecords(tenant, ids);
    expect(record?.properties).toMatchObject({ tags: ["prevention", "bylinky"], type: "dentistry" });
  });

  it("creates one option for a label a value names twice", async () => {
    const card = await createHealthCard(
      tenant,
      ids,
      herbsAnswer({ properties: { name: "Tea", tags: [NEW_TAG_VALUE, NEW_TAG_VALUE] } }),
    );

    await confirm(tenant, ids, card.id);

    expect((await optionKeys(tenant, ids.tags)).filter((key) => key === "bylinky")).toEqual(["bylinky"]);
    expect(await healthRecords(tenant, ids)).toHaveLength(1);
  });

  it("writes the option, the record and the card status in one transaction", async () => {
    const card = await createHealthCard(tenant, ids, herbsAnswer());
    const before = await optionKeys(tenant, ids.tags);
    const failure = new Error("roll the confirmation back");

    await expect(
      runInTenant(tenant, () =>
        withTransaction(runtime, async (client) => {
          const confirmed = await confirmWithClient(client, ids, card.id);
          expect(confirmed.properties.status).toBe("confirmed");
          // The confirming transaction sees the option and the record ...
          const inside = await client.query<{ config: unknown }>("SELECT config FROM properties WHERE id = $1", [
            ids.tags,
          ]);
          expect(optionRowsSchema.parse(inside.rows[0]?.config).options.map((option) => option.key)).toContain(
            "bylinky",
          );
          // ... and before it commits, another connection of the same tenant sees neither.
          expect(await optionKeys(tenant, ids.tags)).toEqual(before);
          expect(await healthRecords(tenant, ids)).toEqual([]);
          expect(await cardStatus(tenant, ids, card.id)).toBe("proposed");
          throw failure;
        }),
      ),
    ).rejects.toBe(failure);

    expect(await optionKeys(tenant, ids.tags)).toEqual(before);
    expect(await healthRecords(tenant, ids)).toEqual([]);
  });

  it("leaves the option uncreated when the item create fails after the option was added", async () => {
    const card = await createHealthCard(tenant, ids, herbsAnswer());
    const before = await optionKeys(tenant, ids.tags);
    const failure = new Error("the item create fails");
    let optionSeenByTheCreate: boolean | undefined;
    vi.mocked(createItemWithClient).mockImplementationOnce(async (client, input) => {
      const inside = await client.query<{ config: unknown }>("SELECT config FROM properties WHERE id = $1", [ids.tags]);
      optionSeenByTheCreate = optionRowsSchema
        .parse(inside.rows[0]?.config)
        .options.some((option) => option.key === "bylinky");
      // The key has already replaced the label in the properties the create receives.
      expect(input.properties).toMatchObject({ tags: ["bylinky"] });
      throw failure;
    });

    await expect(confirm(tenant, ids, card.id)).rejects.toBe(failure);

    expect(optionSeenByTheCreate).toBe(true);
    expect(await optionKeys(tenant, ids.tags)).toEqual(before);
    expect(await healthRecords(tenant, ids)).toEqual([]);
    expect(await cardStatus(tenant, ids, card.id)).toBe("proposed");
  });

  it("creates no option for a record with no title, which the required-field check refuses before any write", async () => {
    const card = await createHealthCard(tenant, ids, herbsAnswer());
    const before = await optionKeys(tenant, ids.tags);
    // Raw SQL: no write path stores an envelope without the title, since the tick and revise validate; this is the card
    // an edit that cleared the title leaves behind.
    await admin.query(
      "UPDATE items SET properties = jsonb_set(properties, '{proposal,properties}', $2::jsonb) WHERE id = $1",
      [card.id, JSON.stringify({ tags: [NEW_TAG_VALUE] })],
    );

    vi.mocked(createItemWithClient).mockClear();
    await expectRefusedOnField(confirm(tenant, ids, card.id), "name");

    // The refusal comes before the option is added, so it is not the rollback of the test above.
    expect(createItemWithClient).not.toHaveBeenCalled();
    expect(await optionKeys(tenant, ids.tags)).toEqual(before);
    expect(await healthRecords(tenant, ids)).toEqual([]);
    expect(await cardStatus(tenant, ids, card.id)).toBe("proposed");
  });

  it("refuses a label that an option took after the card was computed, and creates nothing", async () => {
    const card = await createHealthCard(tenant, ids, herbsAnswer());
    await addOption(tenant, ids.tags, "bylinky");
    const before = await optionKeys(tenant, ids.tags);

    const error = await refusal(confirm(tenant, ids, card.id));

    expect(error).toBeInstanceOf(OptionLabelExistsError);
    expect(error).toMatchObject({ code: "option_label_exists", details: { key: "bylinky" } });
    expect(await optionKeys(tenant, ids.tags)).toEqual(before);
    expect(await healthRecords(tenant, ids)).toEqual([]);
    expect(await cardStatus(tenant, ids, card.id)).toBe("proposed");
  });

  it("creates no option for a card that is rejected", async () => {
    const card = await createHealthCard(tenant, ids, herbsAnswer());
    const before = await optionKeys(tenant, ids.tags);

    const rejected = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) => rejectProposalWithClient(client, config(ids), card.id)),
    );

    expect(rejected.properties.status).toBe("rejected");
    expect(await optionKeys(tenant, ids.tags)).toEqual(before);
    expect(await healthRecords(tenant, ids)).toEqual([]);
  });

  it("creates exactly one option and one item when the card is confirmed twice", async () => {
    const card = await createHealthCard(tenant, ids, herbsAnswer());
    const before = await optionKeys(tenant, ids.tags);

    const first = await confirm(tenant, ids, card.id);
    const second = await confirm(tenant, ids, card.id);

    expect(second.id).toBe(first.id);
    expect(second.properties.resultItemId).toBe(first.properties.resultItemId);
    expect(await optionKeys(tenant, ids.tags)).toEqual([...before, "bylinky"]);
    expect(await healthRecords(tenant, ids)).toHaveLength(1);
  });

  it("creates exactly one option when two confirms of the card run at once", async () => {
    const card = await createHealthCard(tenant, ids, herbsAnswer());
    const before = await optionKeys(tenant, ids.tags);

    const results = await Promise.all([confirm(tenant, ids, card.id), confirm(tenant, ids, card.id)]);

    expect(results.map((result) => result.properties.status)).toEqual(["confirmed", "confirmed"]);
    expect(await optionKeys(tenant, ids.tags)).toEqual([...before, "bylinky"]);
    expect(await healthRecords(tenant, ids)).toHaveLength(1);
  });

  it("creates no option for a listed option that no value uses, after a person changed the value on the card", async () => {
    const card = await createHealthCard(tenant, ids, herbsAnswer());
    const before = await optionKeys(tenant, ids.tags);

    const edited = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) =>
        updateProposalValuesWithClient(client, config(ids), card.id, { set: { primary: { tags: ["medication"] } } }),
      ),
    );
    expect(storedEnvelope(edited.item).newOptions).toEqual([NEW_TAG]);
    await confirm(tenant, ids, card.id);

    expect(await optionKeys(tenant, ids.tags)).toEqual(before);
    const [record] = await healthRecords(tenant, ids);
    expect(record?.properties).toMatchObject({ tags: ["medication"] });
  });

  it("keeps the new option when a person edits another value on the card", async () => {
    const card = await createHealthCard(tenant, ids, herbsAnswer());

    await runInTenant(tenant, () =>
      withTransaction(runtime, (client) =>
        updateProposalValuesWithClient(client, config(ids), card.id, { set: { primary: { name: "Tea" } } }),
      ),
    );
    await confirm(tenant, ids, card.id);

    expect(await optionKeys(tenant, ids.tags)).toContain("bylinky");
    const [record] = await healthRecords(tenant, ids);
    expect(record?.properties).toMatchObject({ name: "Tea", tags: ["bylinky"] });
  });

  it("confirms an envelope without newOptions as before and creates no option", async () => {
    const card = await createHealthCard(tenant, ids, { properties: { name: "Evening pills", tags: ["medication"] } });
    const before = await optionKeys(tenant, ids.tags);

    const confirmed = await confirm(tenant, ids, card.id);

    expect(confirmed.properties.status).toBe("confirmed");
    expect(await optionKeys(tenant, ids.tags)).toEqual(before);
    const [record] = await healthRecords(tenant, ids);
    expect(record?.properties).toMatchObject({ tags: ["medication"] });
  });

  it("refuses a revise that names a new option the card never listed", async () => {
    const card = await createHealthCard(tenant, ids, { properties: { name: "Evening pills", tags: ["medication"] } });

    await expectRefusedOnField(
      runInTenant(tenant, () =>
        withTransaction(runtime, (client) =>
          reviseProposalWithClient(client, config(ids), card.id, {
            message: "Use the herbs tag",
            entityKind: "database",
            target: ids.healthRecords,
            properties: { name: "Evening pills", tags: [NEW_TAG_VALUE] },
          }),
        ),
      ),
      "tags",
    );
    expect(await optionKeys(tenant, ids.tags)).not.toContain("bylinky");
  });

  it("keeps the new option through a revise that still names it, and confirms it", async () => {
    const card = await createHealthCard(tenant, ids, herbsAnswer());

    const revised = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) =>
        reviseProposalWithClient(client, config(ids), card.id, {
          message: "Change the title",
          entityKind: "database",
          target: ids.healthRecords,
          properties: { name: "Herbal tea, twice a day", tags: [NEW_TAG_VALUE] },
        }),
      ),
    );

    expect(storedEnvelope(revised).newOptions).toEqual([NEW_TAG]);
    expect(parseStoredProposalEnvelope(revised.properties.aiProposal, revised.id)).toMatchObject({
      newOptions: [NEW_TAG],
    });
    await confirm(tenant, ids, card.id);
    expect(await optionKeys(tenant, ids.tags)).toContain("bylinky");
    const [record] = await healthRecords(tenant, ids);
    expect(record?.properties).toMatchObject({ name: "Herbal tea, twice a day", tags: ["bylinky"] });
  });

  it("drops the new option when a revise no longer names it, and creates no option", async () => {
    const card = await createHealthCard(tenant, ids, herbsAnswer());
    const before = await optionKeys(tenant, ids.tags);

    const revised = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) =>
        reviseProposalWithClient(client, config(ids), card.id, {
          message: "Use the medication tag",
          entityKind: "database",
          target: ids.healthRecords,
          properties: { name: "Herbal tea", tags: ["medication"] },
        }),
      ),
    );

    expect(storedEnvelope(revised)).not.toHaveProperty("newOptions");
    await confirm(tenant, ids, card.id);
    expect(await optionKeys(tenant, ids.tags)).toEqual(before);
  });

  it("keeps the new option through a revise from the item thread, and confirms it", async () => {
    const card = await createHealthCard(tenant, ids, herbsAnswer());
    const subjectItemId = await runInTenant(tenant, () =>
      withTransaction(runtime, async (client) => {
        const sourceInbox = await propertiesStore.getPropertyByKey(client, ids.proposals, "sourceInbox");
        const definition = await relationsStore.getRelationDefinitionByPropertyId(client, sourceInbox!.id);
        const [edge] = await relationsStore.listRelationsForItem(client, definition!.id, card.id);
        return relationsStore.otherSide(edge!, card.id);
      }),
    );

    const revised = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) =>
        reviseProposalFromThreadWithClient(client, config(ids), {
          proposalId: card.id,
          subjectItemId,
          threadId: randomUUID(),
          messageId: randomUUID(),
          entityKind: "database",
          target: ids.healthRecords,
          properties: { name: "Herbal tea, twice a day", tags: [NEW_TAG_VALUE] },
        }),
      ),
    );

    expect(storedEnvelope(revised).newOptions).toEqual([NEW_TAG]);
    await confirm(tenant, ids, card.id);
    expect(await optionKeys(tenant, ids.tags)).toContain("bylinky");
    const [record] = await healthRecords(tenant, ids);
    expect(record?.properties).toMatchObject({ name: "Herbal tea, twice a day", tags: ["bylinky"] });
  });

  it("lets a person set the value to an option that was added after the card was computed, and confirms it", async () => {
    const card = await createHealthCard(tenant, ids, herbsAnswer());
    await addOption(tenant, ids.tags, "Bylinky");
    const before = await optionKeys(tenant, ids.tags);

    await runInTenant(tenant, () =>
      withTransaction(runtime, (client) =>
        updateProposalValuesWithClient(client, config(ids), card.id, { set: { primary: { tags: ["bylinky"] } } }),
      ),
    );
    await confirm(tenant, ids, card.id);

    expect(await optionKeys(tenant, ids.tags)).toEqual(before);
    const [record] = await healthRecords(tenant, ids);
    expect(record?.properties).toMatchObject({ tags: ["bylinky"] });
  });

  it("confirms again after a reopen with the option the first confirm created: one option and one item", async () => {
    const card = await createHealthCard(tenant, ids, herbsAnswer());
    const before = await optionKeys(tenant, ids.tags);
    const first = await confirm(tenant, ids, card.id);

    const reopened = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) => reopenProposalWithClient(client, config(ids), card.id, {})),
    );

    expect(reopened.item.properties.status).toBe("proposed");
    expect(await healthRecords(tenant, ids)).toEqual([]);
    expect(await optionKeys(tenant, ids.tags)).toEqual([...before, "bylinky"]);
    expect(storedEnvelope(reopened.item)).toMatchObject({ properties: { tags: ["bylinky"] } });
    expect(storedEnvelope(reopened.item)).not.toHaveProperty("newOptions");
    expect(parseStoredProposalEnvelope(reopened.item.properties.aiProposal, card.id)).toMatchObject({
      properties: { tags: ["bylinky"] },
    });
    expect(parseStoredProposalEnvelope(reopened.item.properties.aiProposal, card.id)).not.toHaveProperty("newOptions");

    const second = await confirm(tenant, ids, card.id);

    expect(second.properties.status).toBe("confirmed");
    expect(second.properties.resultItemId).not.toBe(first.properties.resultItemId);
    expect(await optionKeys(tenant, ids.tags)).toEqual([...before, "bylinky"]);
    const records = await healthRecords(tenant, ids);
    expect(records.map((record) => record.id)).toEqual([second.properties.resultItemId]);
    expect(records[0]?.properties).toMatchObject({ name: "Herbal tea against a cold", tags: ["bylinky"] });
  });

  it("rewrites a manual value that names the new option when the card is reopened, and keeps what the person edited", async () => {
    const card = await createHealthCard(tenant, ids, herbsAnswer());
    await runInTenant(tenant, () =>
      withTransaction(runtime, (client) =>
        updateProposalValuesWithClient(client, config(ids), card.id, {
          set: { primary: { name: "Tea", tags: ["medication", NEW_TAG_VALUE] } },
        }),
      ),
    );
    await confirm(tenant, ids, card.id);

    const reopened = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) => reopenProposalWithClient(client, config(ids), card.id, {})),
    );

    expect(reopened.item.properties.userOverrides).toEqual({
      primary: { name: "Tea", tags: ["medication", "bylinky"] },
    });
    expect(reopened.item.properties.userEditedKeys).toEqual(["primary.name", "primary.tags"]);
    await confirm(tenant, ids, card.id);
    const [record] = await healthRecords(tenant, ids);
    expect(record?.properties).toMatchObject({ name: "Tea", tags: ["medication", "bylinky"] });
    expect((await optionKeys(tenant, ids.tags)).filter((key) => key === "bylinky")).toHaveLength(1);
  });

  it("leaves the stored envelope of a reopened card without new options as it was", async () => {
    const card = await createHealthCard(tenant, ids, { properties: { name: "Evening pills", tags: ["medication"] } });
    await confirm(tenant, ids, card.id);

    const reopened = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) => reopenProposalWithClient(client, config(ids), card.id, {})),
    );

    expect(storedEnvelope(reopened.item)).toEqual(storedEnvelope(card));
    expect(reopened.item.properties.aiProposal).toEqual(card.properties.aiProposal);
  });

  it("creates the option in the confirming tenant only, with row-level security in force", async () => {
    const card = await createHealthCard(other, foreign, herbsAnswer());
    const tenantBefore = await optionKeys(tenant, ids.tags);
    const otherBefore = await optionKeys(other, foreign.tags);

    await confirm(other, foreign, card.id);

    expect(await optionKeys(other, foreign.tags)).toEqual([...otherBefore, "bylinky"]);
    expect(await optionKeys(tenant, ids.tags)).toEqual(tenantBefore);
    expect(await healthRecords(tenant, ids)).toEqual([]);
    const [record] = await healthRecords(other, foreign);
    expect(record?.properties).toMatchObject({ tags: ["bylinky"] });
  });
});
