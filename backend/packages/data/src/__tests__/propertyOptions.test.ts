import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { z } from "zod";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { OptionLabelExistsError, PropertyLockedError, SchemaLockedError } from "../errors.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import { seedSystem } from "../seed/seedSystem.js";
import { HEALTH_RECORDS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import type { PropertyRow } from "../types.js";

/**
 * The Health records `tags` options a seeded tenant starts with, in stored order and exactly as stored: the seed gives
 * four of the six a color (issue #1705) and none a label.
 */
const SEEDED_TAGS: { key: string; color?: string }[] = [
  { key: "bloodTests", color: "#FF9500" },
  { key: "medication", color: "#AF52DE" },
  { key: "epilepsy" },
  { key: "dentalHygiene" },
  { key: "bloodPressure", color: "#FF2D55" },
  { key: "prevention", color: "#34C759" },
];

let admin: Pool;
let runtime: Pool;
let chokePoint: ChokePoint;
let first: string;
const invalidation = vi.fn<(event: InvalidationEvent) => void>();

const inFirst = <T>(fn: () => Promise<T>): Promise<T> => runInTenant(first, fn);

function seed(tenantId: string): Promise<unknown> {
  return runInTenant(tenantId, () => seedSystem(runtime, createViewTypeRegistry()));
}

/** A property of the tenant's Health records, a schema-locked system database: `tags` is a multi_select, `status` a select. */
async function healthProperty(tenantId: string, key: "tags" | "status" | "subject"): Promise<PropertyRow> {
  return runInTenant(tenantId, async () => {
    const database = await withTransaction(runtime, (client) =>
      getDatabaseByModuleId(client, HEALTH_RECORDS_MODULE_ID),
    );
    if (!database) throw new Error("Health records database missing");
    expect(database.schemaLocked).toBe(true);
    const property = await chokePoint.getPropertyByKey(database.id, key);
    if (!property) throw new Error(`Health records '${key}' property missing`);
    return property;
  });
}

/** A select property of a database the tenant created itself, so no catalog names its options. */
async function ownSelect(
  config: Record<string, unknown> = {},
  extra: { locked?: boolean; type?: "select" | "multi_select" } = {},
): Promise<PropertyRow> {
  return inFirst(async () => {
    const database = await chokePoint.createDatabase({ name: `Options ${randomUUID()}` });
    return chokePoint.createProperty({
      databaseId: database.id,
      key: "choice",
      name: "Choice",
      type: extra.type ?? "select",
      config,
      locked: extra.locked,
    });
  });
}

const storedRow = z.object({ version: z.string(), config: z.record(z.string(), z.unknown()) });

/**
 * The property row as its tenant reads it on the runtime role. `version` is the row version (`xmin`): it changes with
 * every write to the row, including one that stores equal values.
 */
async function stored(tenantId: string, propertyId: string): Promise<z.infer<typeof storedRow>> {
  return runInTenant(tenantId, async () => {
    const { rows } = await runtime.query<Record<string, unknown>>(
      "SELECT xmin::text AS version, config FROM properties WHERE id = $1",
      [propertyId],
    );
    return storedRow.parse(rows[0]);
  });
}

const storedOptionList = z.array(z.looseObject({ key: z.string() }));

/** The stored options of a property, each checked to carry a key. */
async function storedOptions(tenantId: string, propertyId: string): Promise<z.infer<typeof storedOptionList>> {
  return storedOptionList.parse((await stored(tenantId, propertyId)).config.options);
}

/** The search backfill jobs queued for one database (issue #1652), read through Graphile Worker's public jobs view. */
async function backfillJobs(databaseId: string): Promise<string[]> {
  const { rows } = await admin.query<{ key: string | null; task_identifier: string }>(
    "SELECT key, task_identifier FROM graphile_worker.jobs ORDER BY id",
  );
  return rows.flatMap((job) =>
    job.task_identifier === "itemSearchBackfill" && job.key?.includes(`:${databaseId}:`) === true ? [job.key] : [],
  );
}

async function allJobKeys(): Promise<(string | null)[]> {
  const { rows } = await admin.query<{ key: string | null }>("SELECT key FROM graphile_worker.jobs ORDER BY id");
  return rows.map((job) => job.key);
}

/**
 * Runs `refused`, which must reject, and checks that the property row was not written, no job was queued and no
 * invalidation was sent.
 */
async function expectNoEffect(
  tenantId: string,
  propertyId: string,
  refused: () => Promise<unknown>,
  error: Record<string, unknown>,
): Promise<void> {
  const before = await stored(tenantId, propertyId);
  const jobsBefore = await allJobKeys();
  invalidation.mockClear();
  await expect(runInTenant(tenantId, refused)).rejects.toMatchObject(error);
  expect(await stored(tenantId, propertyId)).toEqual(before);
  expect(await allJobKeys()).toEqual(jobsBefore);
  expect(invalidation).not.toHaveBeenCalled();
}

/** Resolves once `count` sessions wait for the row lock of the option write's `SELECT ... FOR UPDATE`; throws after about ten seconds. */
async function waitForOptionWritersBlocked(count: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { rows } = await admin.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`,
      ["%FROM properties WHERE id = $1 FOR UPDATE%"],
    );
    if ((rows[0]?.waiting ?? 0) >= count) return;
    await delay(50);
  }
  throw new Error(`Fewer than ${count} option writers reached the property row lock`);
}

/**
 * Starts `writers` while another session holds the property's row lock, waits until every one of them is blocked on
 * it, then releases the lock: the writers were all in flight at once, each before its read of the options.
 */
async function runBlockedTogether<T>(
  propertyId: string,
  writers: (() => Promise<T>)[],
): Promise<PromiseSettledResult<T>[]> {
  const blocker = await admin.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM properties WHERE id = $1 FOR UPDATE", [propertyId]);
    const settled = Promise.allSettled(writers.map((writer) => writer()));
    const failures: unknown[] = [];
    try {
      await waitForOptionWritersBlocked(writers.length);
    } catch (error) {
      failures.push(error);
    }
    // The blocker wrote nothing; ending its transaction on both paths lets every writer take the lock and settle.
    try {
      await blocker.query("ROLLBACK");
    } catch (error) {
      failures.push(error);
    }
    const results = await settled;
    if (failures.length > 0) throw new AggregateError(failures, "The option writers were not blocked together");
    return results;
  } finally {
    blocker.release();
  }
}

describe("select options on schema-locked databases (issue #1699)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    chokePoint = createChokePoint(runtime);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    first = getTenantZeroId();
    await seed(first);
    invalidation.mockClear();
    setInvalidationHook(invalidation);
  });
  afterEach(() => setInvalidationHook(() => {}));
  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  describe("property.option.add", () => {
    it("appends 'Bylinky' to the Health records tags as key bylinky, queues the search reindex and sends the schema invalidation", async () => {
      const tags = await healthProperty(first, "tags");
      expect(tags.config).toEqual({ options: SEEDED_TAGS });
      expect(await backfillJobs(tags.databaseId)).toEqual([]);
      const userId = randomUUID();

      const option = await inFirst(() => chokePoint.addPropertyOption(tags.id, { label: "Bylinky" }, userId));

      expect(option).toEqual({ key: "bylinky", label: "Bylinky" });
      expect((await stored(first, tags.id)).config).toEqual({
        options: [...SEEDED_TAGS, { key: "bylinky", label: "Bylinky" }],
      });
      expect(await backfillJobs(tags.databaseId)).toHaveLength(1);
      expect(invalidation).toHaveBeenCalledExactlyOnceWith({ scope: "schema", databaseId: tags.databaseId, userId });
      // The exception is to the lock, not a removal of it.
      expect((await inFirst(() => chokePoint.getDatabase(tags.databaseId)))?.schemaLocked).toBe(true);
    });

    it("adds to a select as to a multi_select, and sends the invalidation without a user when none acts", async () => {
      const status = await healthProperty(first, "status");

      const option = await inFirst(() => chokePoint.addPropertyOption(status.id, { label: "Chronic" }));

      expect(option).toEqual({ key: "chronic", label: "Chronic" });
      expect((await stored(first, status.id)).config.options).toEqual([
        { key: "monitoring", color: "#FF9500" },
        { key: "resolved", color: "#34C759" },
        { key: "chronic", label: "Chronic" },
      ]);
      expect(invalidation).toHaveBeenCalledExactlyOnceWith({
        scope: "schema",
        databaseId: status.databaseId,
        userId: undefined,
      });
    });

    it("stores a color in upper case and keeps the other config keys of the property", async () => {
      const property = await ownSelect({ options: [{ key: "one" }], default: "one" });

      const option = await inFirst(() =>
        chokePoint.addPropertyOption(property.id, { label: "  Two  ", color: "#34c759" }),
      );

      expect(option).toEqual({ key: "two", label: "Two", color: "#34C759" });
      expect((await stored(first, property.id)).config).toEqual({
        options: [{ key: "one" }, { key: "two", label: "Two", color: "#34C759" }],
        default: "one",
      });
    });

    it("adds the first option to a property stored without an options array", async () => {
      const property = await ownSelect();
      expect(property.config).toEqual({});

      const option = await inFirst(() => chokePoint.addPropertyOption(property.id, { label: "First" }));

      expect(option).toEqual({ key: "first", label: "First" });
      expect((await stored(first, property.id)).config).toEqual({ options: [{ key: "first", label: "First" }] });
    });

    it.each([
      ["Dentální hygiena", "dentalniHygiena"],
      ["Bylinky", "bylinky"],
      ["Čaj & káva", "cajKava"],
      ["EKG vyšetření SRDCE", "ekgVysetreniSrdce"],
      ["žluť", "zlut"],
      ["3D tisk", "3dTisk"],
      ["Straße", "straE"],
      ["!!!", "option"],
      ["日本語", "option"],
    ])("derives the key of '%s' as %s", async (label, key) => {
      const property = await ownSelect();

      const option = await inFirst(() => chokePoint.addPropertyOption(property.id, { label }));

      expect(option).toEqual({ key, label });
    });

    it("gives a label whose key is taken the lowest free numeric suffix, also for the `option` fallback", async () => {
      const property = await ownSelect({ options: [{ key: "bylinky3" }] });
      const add = (label: string) => inFirst(() => chokePoint.addPropertyOption(property.id, { label }));

      expect((await add("Bylinky")).key).toBe("bylinky");
      expect((await add("Bylinky!")).key).toBe("bylinky2");
      // `bylinky3` is stored already, so the next free suffix is 4.
      expect((await add("Bylinky?")).key).toBe("bylinky4");
      expect((await add("!!!")).key).toBe("option");
      expect((await add("???")).key).toBe("option2");
      expect((await stored(first, property.id)).config.options).toEqual([
        { key: "bylinky3" },
        { key: "bylinky", label: "Bylinky" },
        { key: "bylinky2", label: "Bylinky!" },
        { key: "bylinky4", label: "Bylinky?" },
        { key: "option", label: "!!!" },
        { key: "option2", label: "???" },
      ]);
    });

    it.each([
      ["the Czech catalog label in another case and without diacritics", "leky", "medication"],
      ["the Czech catalog label as written", "Léky", "medication"],
      ["the English catalog label in upper case", "MEDICATION", "medication"],
      ["a catalog label with surrounding whitespace", "  dentální HYGIENA ", "dentalHygiene"],
    ])("refuses %s with option_label_exists naming the existing key", async (_case, label, key) => {
      const tags = await healthProperty(first, "tags");

      await expectNoEffect(first, tags.id, () => chokePoint.addPropertyOption(tags.id, { label }), {
        name: "OptionLabelExistsError",
        status: 409,
        code: "option_label_exists",
        details: { key },
      });
    });

    it("refuses 'léky' as an OptionLabelExistsError whose message carries no label", async () => {
      const tags = await healthProperty(first, "tags");

      const refusal = await inFirst(() => chokePoint.addPropertyOption(tags.id, { label: "léky" })).catch(
        (error: unknown) => error,
      );

      expect(refusal).toBeInstanceOf(OptionLabelExistsError);
      expect(refusal).toMatchObject({ message: `Property ${tags.id} already has an option with this label` });
    });

    it("refuses a label an option stores, compared without case, diacritics and surrounding whitespace", async () => {
      const property = await ownSelect({ options: [{ key: "herbs", label: " Bylinky " }, { key: "plain" }] });

      await expectNoEffect(first, property.id, () => chokePoint.addPropertyOption(property.id, { label: "BÝLINKY" }), {
        code: "option_label_exists",
        details: { key: "herbs" },
      });
      // An option without a stored label and without a catalog entry has no label that is compared: the key is taken, the label is not.
      const option = await inFirst(() => chokePoint.addPropertyOption(property.id, { label: "Plain" }));
      expect(option).toEqual({ key: "plain2", label: "Plain" });
    });

    it.each([
      ["an empty label", ""],
      ["a label of only whitespace", "   "],
      ["a label of 61 characters", "a".repeat(61)],
      // Neither of the next three can be stored in a jsonb value, so the label is refused before the write.
      ["a label that holds U+0000", "Byl\u0000inky"],
      ["a label of 60 code units cut inside a surrogate pair", `${"a".repeat(59)}\ud83d`],
      ["a label that holds a low surrogate without its pair", "\udc8a Bylinky"],
    ])("refuses %s as validation_failed naming label", async (_case, label) => {
      const tags = await healthProperty(first, "tags");

      await expectNoEffect(first, tags.id, () => chokePoint.addPropertyOption(tags.id, { label }), {
        status: 400,
        code: "validation_failed",
        details: { field: "label" },
      });
    });

    it("accepts a label of 60 characters", async () => {
      const property = await ownSelect();
      const label = "a".repeat(60);

      const option = await inFirst(() => chokePoint.addPropertyOption(property.id, { label }));

      expect(option).toEqual({ key: label, label });
    });

    it("stores a label whose surrogates are all paired, up to 60 UTF-16 code units", async () => {
      const property = await ownSelect();
      // U+1F48A, one character outside the Basic Multilingual Plane: a high surrogate followed by its low surrogate.
      const pill = String.fromCodePoint(0x1f48a);
      const label = pill.repeat(30);
      expect(label).toHaveLength(60);

      const option = await inFirst(() => chokePoint.addPropertyOption(property.id, { label }));

      expect(option).toEqual({ key: "option", label });
      expect((await stored(first, property.id)).config.options).toEqual([{ key: "option", label }]);
    });

    it("refuses a color that is not #RRGGBB through the existing option validation", async () => {
      const tags = await healthProperty(first, "tags");

      await expectNoEffect(
        first,
        tags.id,
        () => chokePoint.addPropertyOption(tags.id, { label: "Bylinky", color: "green" }),
        {
          status: 400,
          code: "validation_failed",
          details: { field: "config" },
        },
      );
    });

    it("adds the hundredth option and refuses the hundred and first", async () => {
      const options = Array.from({ length: 99 }, (_unused, index) => ({ key: `seeded${index}` }));
      const property = await ownSelect({ options });

      const hundredth = await inFirst(() => chokePoint.addPropertyOption(property.id, { label: "Hundredth" }));

      expect(hundredth.key).toBe("hundredth");
      await expectNoEffect(first, property.id, () => chokePoint.addPropertyOption(property.id, { label: "One more" }), {
        status: 400,
        code: "validation_failed",
        details: { reason: "option_limit" },
      });
      expect((await stored(first, property.id)).config.options).toHaveLength(100);
    });

    it("refuses a text property as validation_failed naming propertyId", async () => {
      const subject = await healthProperty(first, "subject");
      expect(subject.type).toBe("text");

      await expectNoEffect(first, subject.id, () => chokePoint.addPropertyOption(subject.id, { label: "Bylinky" }), {
        status: 400,
        code: "validation_failed",
        details: { field: "propertyId" },
      });
    });

    it("refuses a property that is itself locked with PropertyLockedError", async () => {
      const property = await ownSelect({ options: [{ key: "one" }] }, { locked: true });

      await expectNoEffect(first, property.id, () => chokePoint.addPropertyOption(property.id, { label: "Two" }), {
        name: "PropertyLockedError",
        status: 403,
        code: "property_locked",
      });
      await expect(inFirst(() => chokePoint.addPropertyOption(property.id, { label: "Two" }))).rejects.toBeInstanceOf(
        PropertyLockedError,
      );
    });

    it("answers an unknown property id with not_found", async () => {
      const jobsBefore = await allJobKeys();

      await expect(
        inFirst(() => chokePoint.addPropertyOption(randomUUID(), { label: "Bylinky" })),
      ).rejects.toMatchObject({ name: "NotFoundError", status: 404, code: "not_found" });

      expect(await allJobKeys()).toEqual(jobsBefore);
      expect(invalidation).not.toHaveBeenCalled();
    });

    it("refuses to extend a stored options array that the option validation does not accept", async () => {
      const property = await ownSelect({ options: [{ key: "one" }] });
      // Raw SQL as the owner: the choke point refuses to write an option without a key, which only a legacy row holds.
      const corrupted = await admin.query("UPDATE properties SET config = $3::jsonb WHERE tenant_id = $1 AND id = $2", [
        first,
        property.id,
        JSON.stringify({ options: [{ key: "one" }, { label: "No key" }] }),
      ]);
      expect(corrupted.rowCount).toBe(1);

      await expectNoEffect(first, property.id, () => chokePoint.addPropertyOption(property.id, { label: "Two" }), {
        status: 400,
        code: "validation_failed",
        details: { field: "config" },
      });
    });
  });

  describe("concurrent writers", () => {
    it("keeps both options when two adds run concurrently", async () => {
      const tags = await healthProperty(first, "tags");

      const results = await runBlockedTogether(tags.id, [
        () => inFirst(() => chokePoint.addPropertyOption(tags.id, { label: "Bylinky" })),
        () => inFirst(() => chokePoint.addPropertyOption(tags.id, { label: "Vitamíny" })),
      ]);

      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      const options = await storedOptions(first, tags.id);
      // The seeded options come first; the two new ones follow in whichever order their transactions ran.
      expect(options.slice(0, SEEDED_TAGS.length)).toEqual(SEEDED_TAGS);
      expect(options.slice(SEEDED_TAGS.length).sort((a, b) => a.key.localeCompare(b.key))).toEqual([
        { key: "bylinky", label: "Bylinky" },
        { key: "vitaminy", label: "Vitamíny" },
      ]);
    });

    it("stores a label once when two concurrent adds carry it, refusing the later one with the earlier one's key", async () => {
      const tags = await healthProperty(first, "tags");

      const results = await runBlockedTogether(tags.id, [
        () => inFirst(() => chokePoint.addPropertyOption(tags.id, { label: "Bylinky" })),
        () => inFirst(() => chokePoint.addPropertyOption(tags.id, { label: "bylinky" })),
      ]);

      const fulfilled = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
      const rejected = results.flatMap((result): unknown[] => (result.status === "rejected" ? [result.reason] : []));
      expect(fulfilled).toHaveLength(1);
      expect(fulfilled[0]?.key).toBe("bylinky");
      expect(rejected).toEqual([expect.objectContaining({ code: "option_label_exists", details: { key: "bylinky" } })]);
      expect((await stored(first, tags.id)).config.options).toEqual([...SEEDED_TAGS, fulfilled[0]]);
    });

    it("keeps an added option when a rename of another option runs concurrently", async () => {
      const property = await ownSelect({ options: [{ key: "one", label: "One" }] });

      const results = await runBlockedTogether<unknown>(property.id, [
        () => inFirst(() => chokePoint.addPropertyOption(property.id, { label: "Two" })),
        () => inFirst(() => chokePoint.updatePropertyOption(property.id, "one", { label: "Uno" }, "en")),
      ]);

      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      expect((await stored(first, property.id)).config.options).toEqual([
        { key: "one", label: "Uno" },
        { key: "two", label: "Two" },
      ]);
    });
  });

  describe("property.option.update", () => {
    it("renames and recolors an added option under the same key and position and sends the schema invalidation", async () => {
      const tags = await healthProperty(first, "tags");
      await inFirst(() => chokePoint.addPropertyOption(tags.id, { label: "Bylinky" }));
      await inFirst(() => chokePoint.addPropertyOption(tags.id, { label: "Vitamíny" }));
      invalidation.mockClear();
      const userId = randomUUID();

      const option = await inFirst(() =>
        chokePoint.updatePropertyOption(tags.id, "bylinky", { label: "Herbs", color: "#ff9500" }, "en", userId),
      );

      expect(option).toEqual({ key: "bylinky", label: "Herbs", color: "#FF9500" });
      expect((await stored(first, tags.id)).config).toEqual({
        options: [
          ...SEEDED_TAGS,
          { key: "bylinky", label: "Herbs", color: "#FF9500" },
          { key: "vitaminy", label: "Vitamíny" },
        ],
      });
      expect(invalidation).toHaveBeenCalledExactlyOnceWith({ scope: "schema", databaseId: tags.databaseId, userId });
    });

    it.each([
      ["cs", "Léky"],
      ["en", "Medication"],
      ["de", "Medication"],
    ])(
      "recolors a catalog option without storing a label, returns its %s catalog label and queues the search reindex",
      async (locale, label) => {
        const tags = await healthProperty(first, "tags");
        expect(await backfillJobs(tags.databaseId)).toEqual([]);

        const option = await inFirst(() =>
          chokePoint.updatePropertyOption(tags.id, "medication", { color: "#ff3b30" }, locale),
        );

        expect(option).toEqual({ key: "medication", label, color: "#FF3B30" });
        expect(await backfillJobs(tags.databaseId)).toHaveLength(1);
        // The new color replaces the one the seed stored on `medication`; every other option is as seeded.
        expect((await stored(first, tags.id)).config.options).toEqual(
          SEEDED_TAGS.map((seeded) => (seeded.key === "medication" ? { key: "medication", color: "#FF3B30" } : seeded)),
        );
      },
    );

    it("renames without touching a stored color, and recolors without touching a stored label", async () => {
      const property = await ownSelect({ options: [{ key: "one", label: "One", color: "#112233" }] });

      const renamed = await inFirst(() =>
        chokePoint.updatePropertyOption(property.id, "one", { label: " Uno " }, "en"),
      );
      expect(renamed).toEqual({ key: "one", label: "Uno", color: "#112233" });

      const recolored = await inFirst(() =>
        chokePoint.updatePropertyOption(property.id, "one", { color: "#445566" }, "en"),
      );
      expect(recolored).toEqual({ key: "one", label: "Uno", color: "#445566" });
      expect((await stored(first, property.id)).config.options).toEqual([
        { key: "one", label: "Uno", color: "#445566" },
      ]);
    });

    it("lets an option take its own label in another case, and a catalog option its own catalog label", async () => {
      const tags = await healthProperty(first, "tags");
      await inFirst(() => chokePoint.addPropertyOption(tags.id, { label: "Bylinky" }));

      const recased = await inFirst(() =>
        chokePoint.updatePropertyOption(tags.id, "bylinky", { label: "BYLINKY" }, "en"),
      );
      const own = await inFirst(() => chokePoint.updatePropertyOption(tags.id, "medication", { label: "Léky" }, "en"));

      expect(recased).toEqual({ key: "bylinky", label: "BYLINKY" });
      // The stored label now wins over the English catalog entry, and the rename returns and keeps the seeded color.
      expect(own).toEqual({ key: "medication", label: "Léky", color: "#AF52DE" });
      expect((await stored(first, tags.id)).config.options).toEqual([
        ...SEEDED_TAGS.map((seeded) => (seeded.key === "medication" ? { ...seeded, label: "Léky" } : seeded)),
        { key: "bylinky", label: "BYLINKY" },
      ]);
    });

    it.each([
      ["the catalog label of another option", "bylinky", "epilepsie", "epilepsy"],
      ["the stored label of another option", "medication", "býlinky", "bylinky"],
    ])("refuses a rename to %s with option_label_exists naming that option", async (_case, key, label, existing) => {
      const tags = await healthProperty(first, "tags");
      await inFirst(() => chokePoint.addPropertyOption(tags.id, { label: "Bylinky" }));

      await expectNoEffect(first, tags.id, () => chokePoint.updatePropertyOption(tags.id, key, { label }, "cs"), {
        name: "OptionLabelExistsError",
        status: 409,
        code: "option_label_exists",
        details: { key: existing },
      });
    });

    it("answers an unknown option key with not_found, also when the patch is empty", async () => {
      const tags = await healthProperty(first, "tags");
      const notFound = {
        name: "NotFoundError",
        status: 404,
        code: "not_found",
        details: { resource: "propertyOption", propertyId: tags.id, key: "missing" },
      };

      await expectNoEffect(
        first,
        tags.id,
        () => chokePoint.updatePropertyOption(tags.id, "missing", { label: "Herbs" }, "en"),
        notFound,
      );
      await expectNoEffect(
        first,
        tags.id,
        () => chokePoint.updatePropertyOption(tags.id, "missing", {}, "en"),
        notFound,
      );
    });

    it("refuses a patch with neither label nor color as validation_failed with reason empty_patch", async () => {
      const tags = await healthProperty(first, "tags");

      await expectNoEffect(first, tags.id, () => chokePoint.updatePropertyOption(tags.id, "medication", {}, "en"), {
        status: 400,
        code: "validation_failed",
        details: { reason: "empty_patch" },
      });
    });

    it.each([
      ["a label of only whitespace", { label: "  " }, { field: "label" }],
      ["a label of 61 characters", { label: "a".repeat(61) }, { field: "label" }],
      // Neither of the next three can be stored in a jsonb value, so the label is refused before the write.
      ["a label that holds U+0000", { label: "Pil\u0000ls" }, { field: "label" }],
      ["a label that is one high surrogate without its pair", { label: "\ud83d" }, { field: "label" }],
      ["a label that ends in a low surrogate without its pair", { label: "Pills \udc8a" }, { field: "label" }],
      ["a color that is not #RRGGBB", { color: "#12345" }, { field: "config" }],
    ])("refuses %s as validation_failed", async (_case, patch, details) => {
      const tags = await healthProperty(first, "tags");

      await expectNoEffect(first, tags.id, () => chokePoint.updatePropertyOption(tags.id, "medication", patch, "en"), {
        status: 400,
        code: "validation_failed",
        details,
      });
    });

    it("renames an option to a label whose surrogates are all paired", async () => {
      const property = await ownSelect({ options: [{ key: "one", label: "One" }] });
      // U+1F48A is stored as a high surrogate followed by its low surrogate.
      const label = `Pills ${String.fromCodePoint(0x1f48a)}`;
      expect(label).toHaveLength(8);

      const option = await inFirst(() => chokePoint.updatePropertyOption(property.id, "one", { label }, "en"));

      expect(option).toEqual({ key: "one", label });
      expect((await stored(first, property.id)).config.options).toEqual([{ key: "one", label }]);
    });

    it("refuses a text property, a locked property and an unknown property like the add does", async () => {
      const subject = await healthProperty(first, "subject");
      const locked = await ownSelect({ options: [{ key: "one" }] }, { locked: true });

      await expectNoEffect(
        first,
        subject.id,
        () => chokePoint.updatePropertyOption(subject.id, "one", { label: "Uno" }, "en"),
        {
          status: 400,
          code: "validation_failed",
          details: { field: "propertyId" },
        },
      );
      await expectNoEffect(
        first,
        locked.id,
        () => chokePoint.updatePropertyOption(locked.id, "one", { label: "Uno" }, "en"),
        {
          name: "PropertyLockedError",
          status: 403,
          code: "property_locked",
        },
      );
      await expect(
        inFirst(() => chokePoint.updatePropertyOption(randomUUID(), "one", { label: "Uno" }, "en")),
      ).rejects.toMatchObject({ name: "NotFoundError", status: 404, code: "not_found" });
      expect(invalidation).not.toHaveBeenCalled();
    });
  });

  describe("what stays forbidden on the schema-locked database", () => {
    it("still refuses property.patch of the tags config with SchemaLockedError, before and after an option was added", async () => {
      const tags = await healthProperty(first, "tags");
      const replacement = { options: [...SEEDED_TAGS, { key: "bylinky", label: "Bylinky" }] };
      const patches = [
        () => chokePoint.updateProperty(tags.id, { config: replacement }),
        () => chokePoint.updatePropertyWithDatabase(tags.id, { config: replacement }),
        () => chokePoint.updatePropertyConfig(tags.id, replacement),
      ];
      const schemaLocked = { name: "SchemaLockedError", status: 403, code: "schema_locked" };

      for (const patch of patches) await expectNoEffect(first, tags.id, patch, schemaLocked);
      await inFirst(() => chokePoint.addPropertyOption(tags.id, { label: "Bylinky" }));
      for (const patch of patches) await expectNoEffect(first, tags.id, patch, schemaLocked);
      await expect(inFirst(() => chokePoint.updateProperty(tags.id, { config: replacement }))).rejects.toBeInstanceOf(
        SchemaLockedError,
      );
    });

    it("still refuses to create, retype and delete a property of the locked database", async () => {
      const tags = await healthProperty(first, "tags");
      const schemaLocked = { name: "SchemaLockedError", status: 403, code: "schema_locked" };

      await expectNoEffect(
        first,
        tags.id,
        () => chokePoint.createProperty({ databaseId: tags.databaseId, key: "extra", name: "Extra", type: "text" }),
        schemaLocked,
      );
      const subject = await healthProperty(first, "subject");
      await expectNoEffect(first, subject.id, () => chokePoint.changePropertyType(subject.id, "number"), schemaLocked);
      await expectNoEffect(first, tags.id, () => chokePoint.deleteProperty(tags.id), schemaLocked);
    });
  });

  describe("tenant isolation on the runtime role", () => {
    it("answers another tenant's property like an unknown one and leaves it unwritten, while the owner's own write succeeds", async () => {
      const second = await createTestTenant(admin);
      await seed(second);
      const firstTags = await healthProperty(first, "tags");
      const secondTags = await healthProperty(second, "tags");
      expect(secondTags.id).not.toBe(firstTags.id);
      const unknownId = randomUUID();
      const inSecond = <T>(fn: () => Promise<T>): Promise<T> => runInTenant(second, fn);
      const refusalOf = async (attempt: () => Promise<unknown>): Promise<unknown> => {
        const error: unknown = await inSecond(attempt).then(
          () => new Error("the write was not refused"),
          (reason: unknown) => reason,
        );
        if (!(error instanceof Error)) throw new Error("expected an Error");
        const { name, message } = error;
        const fields =
          "status" in error && "code" in error && "details" in error ? [error.status, error.code, error.details] : [];
        return { name, message: message.split(firstTags.id).join("<id>").split(unknownId).join("<id>"), fields };
      };
      const before = await stored(first, firstTags.id);
      const jobsBefore = await allJobKeys();

      for (const write of [
        (id: string) => chokePoint.addPropertyOption(id, { label: "Bylinky" }),
        (id: string) => chokePoint.updatePropertyOption(id, "medication", { label: "Pills", color: "#000000" }, "en"),
      ]) {
        const foreign = await refusalOf(() => write(firstTags.id));
        expect(foreign).toEqual(await refusalOf(() => write(unknownId)));
        expect(foreign).toMatchObject({ name: "NotFoundError", fields: [404, "not_found", undefined] });
      }

      expect(await stored(first, firstTags.id)).toEqual(before);
      expect(await allJobKeys()).toEqual(jobsBefore);
      expect(invalidation).not.toHaveBeenCalled();

      // The same writes on the tenant's own property succeed, and stay in that tenant.
      const added = await inSecond(() => chokePoint.addPropertyOption(secondTags.id, { label: "Bylinky" }));
      const updated = await inSecond(() =>
        chokePoint.updatePropertyOption(secondTags.id, "medication", { label: "Pills", color: "#000000" }, "en"),
      );
      expect(added).toEqual({ key: "bylinky", label: "Bylinky" });
      expect(updated).toEqual({ key: "medication", label: "Pills", color: "#000000" });
      expect((await stored(second, secondTags.id)).config.options).toEqual(
        expect.arrayContaining([
          { key: "bylinky", label: "Bylinky" },
          { key: "medication", label: "Pills", color: "#000000" },
        ]),
      );
      expect(await stored(first, firstTags.id)).toEqual(before);
    });
  });
});
