import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runOnce } from "@semprec/queue";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { runLibraryHeartbeatConfigCutoverMigration } from "../library/libraryHeartbeatConfigCutoverMigration.js";
import { runLibraryBooksYearIsbnCutoverMigration } from "../library/libraryBooksYearIsbnCutoverMigration.js";
import { runTenantCutoverMigrations } from "../db/tenantCutoverMigrations.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import { generateSchemaProjection } from "../manifest/schemaProjection.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  inTenantZero,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { ForbiddenError, ValidationError } from "../errors.js";
import { createActionRegistry } from "../scheduler/actions.js";
import { sweepDueHeartbeats } from "../scheduler/schedulerStore.js";
import { createCoreTaskList } from "../worker.js";
import {
  createLibraryMetadataTriggerAction,
  createLibraryMetadataRetrySweepAction,
  LIBRARY_METADATA_TRIGGER_ACTION_ID,
  LIBRARY_METADATA_RETRY_SWEEP_ACTION_ID,
} from "../library/libraryMetadataActions.js";
import {
  ensureItemAutomation,
  getItemAutomation,
  markItemAutomationDone,
  recordItemAutomationFailure,
  setItemAutomationLocked,
  startItemAutomationAttempt,
} from "../library/itemAutomationStore.js";
import {
  enqueueLibraryMetadataProcessing,
  handleProcessLibraryMetadataTask,
  type LibraryMetadataFetcher,
} from "../library/libraryMetadataJob.js";
import { createUser } from "../auth/usersStore.js";
import { hashPassword } from "../auth/passwordHash.js";
import { LIBRARY_GRID_VIEW_TYPE, registerLibraryGridViewType } from "../views/libraryGridViewType.js";

let pool: Pool;
let chokePoint: ChokePoint;

function libraryRegistry() {
  const registry = createActionRegistry();
  registry.set(LIBRARY_METADATA_TRIGGER_ACTION_ID, createLibraryMetadataTriggerAction(pool));
  registry.set(LIBRARY_METADATA_RETRY_SWEEP_ACTION_ID, createLibraryMetadataRetrySweepAction(pool));
  return registry;
}

async function drainQueue(registry = libraryRegistry(), fetcher?: LibraryMetadataFetcher) {
  await runOnce({ pgPool: pool, taskList: createCoreTaskList(pool, registry, fetcher) });
}

async function getDatabaseIdByModule(moduleId: string): Promise<string> {
  const { rows } = await pool.query<Record<string, unknown>>("SELECT id FROM databases WHERE owner_module_id = $1", [
    moduleId,
  ]);
  return z.object({ id: z.string() }).parse(rows[0]).id;
}

describe("library rating validation", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  const invalidRatings = [7, 2.5, -1, "4", NaN];

  for (const moduleId of ["books", "movies"]) {
    it(`rejects an invalid ${moduleId} rating on create and update, accepts 0 to 5 and null`, async () => {
      const databaseId = await getDatabaseIdByModule(moduleId);
      for (const rating of invalidRatings) {
        await expect(
          inTenantZero(() => chokePoint.createItem({ databaseId, properties: { name: "X", rating } })),
        ).rejects.toMatchObject({ status: 400, details: { field: "rating" } });
      }
      const item = await inTenantZero(() =>
        chokePoint.createItem({ databaseId, properties: { name: "X", rating: 0 } }),
      );
      for (const rating of invalidRatings) {
        const error = await chokePoint
          .updateItem({ databaseId, itemId: item.id, propertiesPatch: { rating } })
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toMatchObject({ details: { field: "rating" } });
      }
      for (const rating of [0, 1, 5, null]) {
        await chokePoint.updateItem({ databaseId, itemId: item.id, propertiesPatch: { rating } });
      }
      const created = await inTenantZero(() =>
        chokePoint.createItem({ databaseId, properties: { name: "Y", rating: 5 } }),
      );
      expect((await chokePoint.getItem(databaseId, created.id))?.properties.rating).toBe(5);
    });

    it(`validates only the keys present in a ${moduleId} patch`, async () => {
      const databaseId = await getDatabaseIdByModule(moduleId);
      // Seed a stored invalid value behind the hooks; an unrelated patch must still succeed.
      const item = await inTenantZero(() => chokePoint.createItem({ databaseId, properties: { name: "X" } }));
      await pool.query(`UPDATE items SET properties = jsonb_set(properties, '{rating}', '9'::jsonb) WHERE id = $1`, [
        item.id,
      ]);
      await chokePoint.updateItem({ databaseId, itemId: item.id, propertiesPatch: { name: "Renamed" } });
    });
  }

  it("validates watchedWith edge metadata.rating from 1 to 5 and leaves other edges valid", async () => {
    const moviesId = await getDatabaseIdByModule("movies");
    const peopleId = await getDatabaseIdByModule("people");
    const movie = await inTenantZero(() => chokePoint.createItem({ databaseId: moviesId, properties: { name: "M" } }));
    const person = await inTenantZero(() =>
      chokePoint.createItem({ databaseId: peopleId, properties: { name: "Alex" } }),
    );
    const watchedWith = (await chokePoint.listProperties(moviesId)).find((p) => p.key === "watchedWith")!;
    const edge = (metadata?: Record<string, unknown>) =>
      chokePoint.createRelation({
        relationPropertyId: watchedWith.id,
        callerItemId: movie.id,
        targetItemId: person.id,
        metadata,
      });

    for (const rating of [9, 0, 2.5, "4"]) {
      await expect(edge({ rating })).rejects.toMatchObject({ status: 400, details: { field: "metadata.rating" } });
    }
    await edge({ rating: 4 });
    await edge({ rating: 1 });
    await edge({ note: "fun" });
    await edge(undefined);
  });

  it("does not validate rating on a database of another module", async () => {
    const database = await chokePoint.createDatabase({ name: "Other", ownerModuleId: "ratingProbe" });
    await chokePoint.createProperty({ databaseId: database.id, key: "name", name: "Name", type: "title" });
    await chokePoint.createProperty({ databaseId: database.id, key: "rating", name: "Rating", type: "number" });
    const item = await inTenantZero(() =>
      chokePoint.createItem({ databaseId: database.id, properties: { name: "X", rating: 7 } }),
    );
    await chokePoint.updateItem({ databaseId: database.id, itemId: item.id, propertiesPatch: { rating: 2.5 } });
    expect((await chokePoint.getItem(database.id, item.id))?.properties.rating).toBe(2.5);
  });

  it("rejects an unknown stored automation error code while accepting a known code and legacy null", async () => {
    const databaseId = await getDatabaseIdByModule("books");
    const item = await inTenantZero(() => chokePoint.createItem({ databaseId, properties: { name: "Book" } }));
    await inTenantZero(() => withTransaction(pool, (client) => ensureItemAutomation(client, item.id)));
    const read = () => inTenantZero(() => withTransaction(pool, (client) => getItemAutomation(client, item.id)));
    expect((await read())?.errorCode).toBeNull();
    await pool.query("UPDATE item_automation SET error_code = 'deleted' WHERE item_id = $1", [item.id]);
    expect((await read())?.errorCode).toBe("deleted");
    await pool.query("UPDATE item_automation SET error_code = 'unexpected' WHERE item_id = $1", [item.id]);
    await expect(read()).rejects.toThrow("Unknown item automation error code");
  });
});

describe("library module (issue #25)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("seeds Books and Movies/TV as concrete instantiations of the generic contract", async () => {
    const booksId = await getDatabaseIdByModule("books");
    const moviesId = await getDatabaseIdByModule("movies");
    const books = await chokePoint.listProperties(booksId);
    const movies = await chokePoint.listProperties(moviesId);

    expect(books.map((p) => p.key).sort()).toEqual(["author", "cover", "isbn", "name", "rating", "status", "year"]);
    expect(movies.map((p) => p.key).sort()).toEqual(
      [
        "cover",
        "name",
        "notes",
        "rating",
        "secondaryRating",
        "sourceUrl",
        "status",
        "type",
        "watchedWith",
        "year",
      ].sort(),
    );

    expect(books.find((p) => p.key === "year")).toMatchObject({ type: "number", owner: "user", name: null });
    expect(books.find((p) => p.key === "isbn")).toMatchObject({ type: "text", owner: "user", name: null });
    expect(books.find((p) => p.key === "cover")).toMatchObject({ type: "image", owner: "system" });
    expect(movies.find((p) => p.key === "year")).toMatchObject({ type: "number", owner: "user" });
    expect(movies.find((p) => p.key === "secondaryRating")).toMatchObject({ type: "number", owner: "system" });
    expect(movies.find((p) => p.key === "sourceUrl")).toMatchObject({ type: "url", owner: "system" });

    const booksViews = await chokePoint.listViewsByDatabase(booksId);
    expect(booksViews).toHaveLength(1);
    expect(booksViews[0]!.type).toBe("library-grid");
    expect(booksViews[0]!.config).toMatchObject({ coverKey: "cover", subtitleKey: "author", statusKey: "status" });
    expect(booksViews[0]!.config).not.toHaveProperty("secondaryRatingLabel");

    const moviesViews = await chokePoint.listViewsByDatabase(moviesId);
    expect(moviesViews[0]!.config).toMatchObject({
      coverKey: "cover",
      subtitleKey: "year",
      ratingKey: "rating",
      secondaryRatingKey: "secondaryRating",
      secondaryRatingLabel: "property.movies.secondaryRating.name",
      sourceUrlKey: "sourceUrl",
      statusKey: "status",
      coverGlyph: "🎬",
    });
  });

  it("fills empty declared fields without overwriting user input or locked items", async () => {
    const databaseId = await getDatabaseIdByModule("books");
    const config = { source: "openLibrary", coverKey: "cover", authorKey: "author", yearKey: "year", isbnKey: "isbn" };
    const empty = await inTenantZero(() => chokePoint.createItem({ databaseId, properties: { name: "Empty" } }));
    const entered = await inTenantZero(() =>
      chokePoint.createItem({ databaseId, properties: { name: "Entered", author: "User" } }),
    );
    const locked = await inTenantZero(() => chokePoint.createItem({ databaseId, properties: { name: "Locked" } }));
    const lockedBefore = (await chokePoint.getItem(databaseId, locked.id))?.properties;
    for (const item of [empty, entered, locked])
      await withTransaction(pool, (client) => ensureItemAutomation(client, item.id));
    await withTransaction(pool, (client) => setItemAutomationLocked(client, locked.id, true));
    for (const item of [empty, entered, locked]) {
      await inTenantZero(() =>
        handleProcessLibraryMetadataTask(pool, { itemId: item.id, databaseId, config }, async () => ({
          author: "Fetched",
          year: 2020,
        })),
      );
    }
    expect((await chokePoint.getItem(databaseId, empty.id))?.properties).toMatchObject({
      author: "Fetched",
      year: 2020,
    });
    expect((await chokePoint.getItem(databaseId, entered.id))?.properties).toMatchObject({
      author: "User",
      year: 2020,
    });
    expect((await chokePoint.getItem(databaseId, locked.id))?.properties).toEqual(lockedBefore);
  });

  it("preserves an author entered while the metadata fetch is in flight", async () => {
    const databaseId = await getDatabaseIdByModule("books");
    const item = await inTenantZero(() => chokePoint.createItem({ databaseId, properties: { name: "Book" } }));
    await withTransaction(pool, (client) => ensureItemAutomation(client, item.id));
    await inTenantZero(() =>
      handleProcessLibraryMetadataTask(
        pool,
        { itemId: item.id, databaseId, config: { source: "openLibrary", coverKey: "cover", authorKey: "author" } },
        async () => {
          await chokePoint.updateItem({ databaseId, itemId: item.id, propertiesPatch: { author: "User" } });
          return { author: "Fetched" };
        },
      ),
    );
    expect((await chokePoint.getItem(databaseId, item.id))?.properties.author).toBe("User");
  });

  it("does not apply a result when automation is locked during the fetch", async () => {
    const databaseId = await getDatabaseIdByModule("books");
    const item = await inTenantZero(() => chokePoint.createItem({ databaseId, properties: { name: "Book" } }));
    await withTransaction(pool, (client) => ensureItemAutomation(client, item.id));
    const before = (await chokePoint.getItem(databaseId, item.id))?.properties;
    await inTenantZero(() =>
      handleProcessLibraryMetadataTask(
        pool,
        { itemId: item.id, databaseId, config: { source: "openLibrary", coverKey: "cover", authorKey: "author" } },
        async () => {
          await withTransaction(pool, (client) => setItemAutomationLocked(client, item.id, true));
          return { author: "Fetched" };
        },
      ),
    );
    expect((await chokePoint.getItem(databaseId, item.id))?.properties).toEqual(before);
    expect((await withTransaction(pool, (client) => getItemAutomation(client, item.id)))?.status).toBe("locked");
  });

  it("skips an invalid movie type while applying other metadata", async () => {
    const databaseId = await getDatabaseIdByModule("movies");
    const item = await inTenantZero(() => chokePoint.createItem({ databaseId, properties: { name: "Film" } }));
    await withTransaction(pool, (client) => ensureItemAutomation(client, item.id));
    await inTenantZero(() =>
      handleProcessLibraryMetadataTask(
        pool,
        {
          itemId: item.id,
          databaseId,
          config: { source: "tmdb", coverKey: "cover", typeKey: "type", yearKey: "year" },
        },
        async () => ({ type: "invalid", year: 2021 }),
      ),
    );
    const result = await chokePoint.getItem(databaseId, item.id);
    expect(result?.properties.year).toBe(2021);
    expect(result?.properties.type).toBeUndefined();
  });

  it("upgrades both heartbeat configs and leaves the second run unchanged", async () => {
    const booksId = await getDatabaseIdByModule("books");
    const moviesId = await getDatabaseIdByModule("movies");
    await pool.query(
      `UPDATE project_heartbeats SET action_config = (action_config - 'authorKey' - 'yearKey' - 'isbnKey' - 'typeKey') || '{"source":"none"}'::jsonb WHERE action_id = ANY($1::text[]) AND action_config->>'databaseId' = ANY($2::text[])`,
      [
        [LIBRARY_METADATA_TRIGGER_ACTION_ID, LIBRARY_METADATA_RETRY_SWEEP_ACTION_ID],
        [booksId, moviesId],
      ],
    );
    const read = async () =>
      (
        await pool.query<{ id: string; action_config: Record<string, unknown>; xmin: string }>(
          `SELECT id, action_config, xmin::text FROM project_heartbeats WHERE action_id = ANY($1::text[]) AND action_config->>'databaseId' = ANY($2::text[]) ORDER BY id`,
          [
            [LIBRARY_METADATA_TRIGGER_ACTION_ID, LIBRARY_METADATA_RETRY_SWEEP_ACTION_ID],
            [booksId, moviesId],
          ],
        )
      ).rows;
    await inTenantZero(() => runLibraryHeartbeatConfigCutoverMigration(pool));
    const first = await read();
    expect(first).toHaveLength(4);
    expect(first.filter((row) => row.action_config.databaseId === booksId).map((row) => row.action_config)).toEqual(
      Array(2).fill(
        expect.objectContaining({ source: "openLibrary", authorKey: "author", yearKey: "year", isbnKey: "isbn" }),
      ),
    );
    expect(first.filter((row) => row.action_config.databaseId === moviesId).map((row) => row.action_config)).toEqual(
      Array(2).fill(expect.objectContaining({ source: "tmdb", yearKey: "year", typeKey: "type" })),
    );
    await inTenantZero(() => runLibraryHeartbeatConfigCutoverMigration(pool));
    expect(await read()).toEqual(first);
  });

  it("runtime-validates every library-grid contract field", () => {
    const registry = createViewTypeRegistry();
    const definition = registry.get(LIBRARY_GRID_VIEW_TYPE);
    expect(definition).toBeUndefined();

    // Registration is the runtime boundary for persisted view configs.
    registerLibraryGridViewType(registry);
    const schema = registry.get(LIBRARY_GRID_VIEW_TYPE)?.configSchema;
    expect(
      schema?.safeParse({
        coverKey: "cover",
        subtitleKey: "year",
        ratingKey: "rating",
        secondaryRatingKey: "secondaryRating",
        secondaryRatingLabel: "property.movies.secondaryRating.name",
        sourceUrlKey: "sourceUrl",
        statusKey: "status",
        coverGlyph: "🎬",
      }).success,
    ).toBe(true);
    expect(schema?.safeParse({ coverKey: "cover", subtitleKey: "year", ratingKey: "rating" }).success).toBe(false);
    expect(
      schema?.safeParse({ coverKey: "cover", subtitleKey: "year", ratingKey: "rating", statusKey: 1 }).success,
    ).toBe(false);
  });

  it("rejects writing owner:'system' library fields through the generic create/update path", async () => {
    const booksId = await getDatabaseIdByModule("books");
    await expect(
      inTenantZero(() =>
        chokePoint.createItem({ databaseId: booksId, properties: { name: "Dune", cover: { blobId: "x" } } }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const item = await inTenantZero(() => chokePoint.createItem({ databaseId: booksId, properties: { name: "Dune" } }));
    await expect(
      chokePoint.updateItem({ databaseId: booksId, itemId: item.id, propertiesPatch: { cover: { blobId: "x" } } }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("creating a library item drives processLibraryMetadata end to end, storing a real blob as the cover", async () => {
    const booksId = await getDatabaseIdByModule("books");
    const registry = libraryRegistry();
    const item = await inTenantZero(() =>
      chokePoint.createItem({
        databaseId: booksId,
        properties: { name: "Dune", author: "Frank Herbert" },
      }),
    );

    // `runOnce` drains cascading enqueues within one call: the choke-point's onItemEvent
    // trigger -> heartbeatFireCore -> our trigger action (seeds item_automation, enqueues the
    // real job) -> processLibraryMetadata itself, using an injected fetcher (the real
    // metadata source is out of this issue's scope).
    const fetcher: LibraryMetadataFetcher = async () => ({
      cover: { mimeType: "image/jpeg", byteSize: 12345, storageKey: "covers/dune.jpg" },
    });
    await drainQueue(registry, fetcher);

    const updated = await chokePoint.getItem(booksId, item.id);
    expect(updated?.properties.cover).toMatchObject({ blobId: expect.any(String) });

    const done = await withTransaction(pool, (client) => getItemAutomation(client, item.id));
    expect(done?.status).toBe("done");
  });

  it("a failed fetch records the error and increments attempts, leaving the row in 'error'", async () => {
    const moviesId = await getDatabaseIdByModule("movies");
    const registry = libraryRegistry();
    const item = await inTenantZero(() =>
      chokePoint.createItem({ databaseId: moviesId, properties: { name: "Sicario", year: 2015 } }),
    );

    const failingFetcher: LibraryMetadataFetcher = async () => {
      throw new Error("private-provider-secret https://secret.invalid");
    };
    await drainQueue(registry, failingFetcher);

    const automation = await withTransaction(pool, (client) => getItemAutomation(client, item.id));
    expect(automation?.status).toBe("error");
    expect(automation?.error).toBe("Library metadata processing failed");
    expect(automation?.attempts).toBe(1);
    expect(JSON.stringify(automation)).not.toContain("private-provider-secret");
  });

  it("writes an automation_error notification on failure, deduped by job id but not across distinct failing jobs (issue #149)", async () => {
    const moviesId = await getDatabaseIdByModule("movies");
    const item = await inTenantZero(() =>
      chokePoint.createItem({ databaseId: moviesId, properties: { name: "Sicario", year: 2015 } }),
    );
    const passwordHash = await hashPassword("s3cret-password");
    const user = await createUser(pool, {
      email: "owner@example.test",
      passwordHash,
      locale: "en",
      tenantId: getTenantZeroId(),
    });

    const failingFetcher: LibraryMetadataFetcher = async () => {
      throw new Error("source unavailable");
    };
    const payload = { itemId: item.id, databaseId: moviesId, config: { source: "test", coverKey: "cover" } };

    await expect(
      handleProcessLibraryMetadataTask(pool, payload, failingFetcher, { job: { id: "job-1" } }),
    ).rejects.toThrow("Library metadata processing failed");

    const { rows: afterFirst } = await pool.query(
      `SELECT user_id, kind, title, link_href, source_table, source_id, transition_instance FROM notifications WHERE source_id = $1`,
      [item.id],
    );
    expect(afterFirst).toMatchObject([
      {
        user_id: user.id,
        kind: "automation_error",
        title: "Item automation failed",
        link_href: `?page=library-item&id=${item.id}`,
        source_table: "item_automation",
        transition_instance: "job-1",
      },
    ]);

    // Redelivery of the same job must not duplicate the notification.
    await expect(
      handleProcessLibraryMetadataTask(pool, payload, failingFetcher, { job: { id: "job-1" } }),
    ).rejects.toThrow("Library metadata processing failed");
    const { rows: afterReplay } = await pool.query(`SELECT id FROM notifications WHERE source_id = $1`, [item.id]);
    expect(afterReplay).toHaveLength(1);

    // A later, independent failure (a new job) is a different transition and does insert.
    await expect(
      handleProcessLibraryMetadataTask(pool, payload, failingFetcher, { job: { id: "job-2" } }),
    ).rejects.toThrow("Library metadata processing failed");
    const { rows: afterNewTransition } = await pool.query(`SELECT id FROM notifications WHERE source_id = $1`, [
      item.id,
    ]);
    expect(afterNewTransition).toHaveLength(2);
  });

  it("skips the automation_error notification (but still records the failure) before any user account exists (issue #149)", async () => {
    const moviesId = await getDatabaseIdByModule("movies");
    const item = await inTenantZero(() =>
      chokePoint.createItem({ databaseId: moviesId, properties: { name: "Sicario", year: 2015 } }),
    );
    await withTransaction(pool, (client) => ensureItemAutomation(client, item.id));

    const failingFetcher: LibraryMetadataFetcher = async () => {
      throw new Error("source unavailable");
    };
    const payload = { itemId: item.id, databaseId: moviesId, config: { source: "test", coverKey: "cover" } };

    await expect(
      handleProcessLibraryMetadataTask(pool, payload, failingFetcher, { job: { id: "job-1" } }),
    ).rejects.toThrow("Library metadata processing failed");

    const { rows } = await pool.query(`SELECT id FROM notifications WHERE source_id = $1`, [item.id]);
    expect(rows).toHaveLength(0);
    const automation = await withTransaction(pool, (client) => getItemAutomation(client, item.id));
    expect(automation?.status).toBe("error");
  });

  it("a locked item_automation row is never touched by the heartbeat", async () => {
    const booksId = await getDatabaseIdByModule("books");
    const registry = libraryRegistry();
    const item = await inTenantZero(() => chokePoint.createItem({ databaseId: booksId, properties: { name: "Dune" } }));

    // Pre-seed and lock the row before anything drains — `runOnce` cascades the trigger
    // and the processing job through in one call, so locking "mid-flight" between them
    // isn't observable from a test; pre-locking exercises the same guard in the job itself
    // (`ensureItemAutomation` is a no-op once the row already exists).
    await withTransaction(pool, async (client) => {
      await ensureItemAutomation(client, item.id);
      await setItemAutomationLocked(client, item.id, true);
    });

    let called = false;
    const fetcher: LibraryMetadataFetcher = async () => {
      called = true;
      return {};
    };
    await drainQueue(registry, fetcher);
    expect(called).toBe(false);

    const automation = await withTransaction(pool, (client) => getItemAutomation(client, item.id));
    expect(automation?.status).toBe("locked");
  });

  it("the daily retry sweep re-enqueues rows left in 'error' for that database", async () => {
    const booksId = await getDatabaseIdByModule("books");
    const registry = libraryRegistry();
    const item = await inTenantZero(() => chokePoint.createItem({ databaseId: booksId, properties: { name: "Dune" } }));

    await drainQueue(registry, async () => {
      throw new Error("boom");
    });
    expect((await withTransaction(pool, (client) => getItemAutomation(client, item.id)))?.status).toBe("error");

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM project_heartbeats WHERE action_id = $1 AND action_config ->> 'databaseId' = $2`,
      [LIBRARY_METADATA_RETRY_SWEEP_ACTION_ID, booksId],
    );
    expect(rows).toHaveLength(1);
    await pool.query("UPDATE project_heartbeats SET next_fire_at = now() - interval '1 minute' WHERE id = $1", [
      rows[0]!.id,
    ]);
    await inTenantZero(() => withTransaction(pool, (client) => sweepDueHeartbeats(client)));

    await drainQueue(registry); // heartbeatFireCore -> retry sweep action -> re-enqueues processLibraryMetadata
    await drainQueue(registry, async () => ({})); // the re-enqueued job itself, now succeeding

    const recovered = await withTransaction(pool, (client) => getItemAutomation(client, item.id));
    expect(recovered?.status).toBe("done");
    expect(recovered?.attempts).toBe(1); // unchanged by the successful retry, only failures increment it
  });

  it("stores a per-relation rating on the Movies -> People edge, not on either item", async () => {
    const moviesId = await getDatabaseIdByModule("movies");
    const peopleId = await getDatabaseIdByModule("people");

    const movie = await inTenantZero(() =>
      chokePoint.createItem({ databaseId: moviesId, properties: { name: "Arrival", year: 2016 } }),
    );
    const person = await inTenantZero(() =>
      chokePoint.createItem({ databaseId: peopleId, properties: { name: "Alex" } }),
    );

    const watchedWith = (await chokePoint.listProperties(moviesId)).find((p) => p.key === "watchedWith")!;
    await chokePoint.createRelation({
      relationPropertyId: watchedWith.id,
      callerItemId: movie.id,
      targetItemId: person.id,
      metadata: { rating: 4 },
    });

    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT metadata FROM item_relations WHERE item_a = $1 OR item_b = $1`,
      [movie.id],
    );
    expect(rows).toHaveLength(1);
    expect(z.object({ metadata: z.record(z.string(), z.unknown()) }).parse(rows[0]).metadata).toEqual({ rating: 4 });

    // Not a property on either side.
    expect((await chokePoint.getItem(moviesId, movie.id))?.properties.rating).toBeUndefined();
  });

  it("excludes a soft-deleted item's errored row from the daily retry sweep's re-enqueue", async () => {
    const booksId = await getDatabaseIdByModule("books");
    const registry = libraryRegistry();
    const item = await inTenantZero(() => chokePoint.createItem({ databaseId: booksId, properties: { name: "Dune" } }));

    await drainQueue(registry, async () => {
      throw new Error("boom");
    });
    expect((await withTransaction(pool, (client) => getItemAutomation(client, item.id)))?.status).toBe("error");

    await chokePoint.softDeleteItem(booksId, item.id);

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM project_heartbeats WHERE action_id = $1 AND action_config ->> 'databaseId' = $2`,
      [LIBRARY_METADATA_RETRY_SWEEP_ACTION_ID, booksId],
    );
    await pool.query("UPDATE project_heartbeats SET next_fire_at = now() - interval '1 minute' WHERE id = $1", [
      rows[0]!.id,
    ]);
    await inTenantZero(() => withTransaction(pool, (client) => sweepDueHeartbeats(client)));

    let called = false;
    await drainQueue(registry, async () => {
      called = true;
      return {};
    });
    expect(called).toBe(false);

    const settled = await withTransaction(pool, (client) => getItemAutomation(client, item.id));
    expect(settled?.status).toBe("error"); // untouched — never re-enqueued in the first place
  });

  it("settles item_automation to 'done' for a job that runs against an already-deleted item", async () => {
    const booksId = await getDatabaseIdByModule("books");
    const registry = libraryRegistry();
    const item = await inTenantZero(() => chokePoint.createItem({ databaseId: booksId, properties: { name: "Dune" } }));
    await chokePoint.softDeleteItem(booksId, item.id);

    // A job enqueued directly (e.g. one already in flight when the delete happened),
    // bypassing the retry sweep's exclusion filter entirely.
    let called = false;
    await inTenantZero(() =>
      withTransaction(pool, (client) =>
        enqueueLibraryMetadataProcessing(client, {
          itemId: item.id,
          databaseId: booksId,
          config: { source: "none", coverKey: "cover" },
        }),
      ),
    );
    await drainQueue(registry, async () => {
      called = true;
      return {};
    });
    expect(called).toBe(false); // the job returns before ever calling the fetcher

    const settled = await withTransaction(pool, (client) => getItemAutomation(client, item.id));
    expect(settled?.status).toBe("done");
  });

  it("startItemAutomationAttempt reopens a row as pending and counts the attempt, keeping the earlier error (issue #248)", async () => {
    const booksId = await getDatabaseIdByModule("books");
    const item = await inTenantZero(() => chokePoint.createItem({ databaseId: booksId, properties: { name: "Dune" } }));
    await withTransaction(pool, (client) => ensureItemAutomation(client, item.id));
    await withTransaction(pool, (client) => recordItemAutomationFailure(client, item.id, "earlier failure", "error"));

    const started = await withTransaction(pool, (client) => startItemAutomationAttempt(client, item.id));
    expect(started).toMatchObject({ itemId: item.id, status: "pending", error: "earlier failure", attempts: 1 });
    expect(started?.lastAttemptAt).not.toBeNull();

    const again = await withTransaction(pool, (client) => startItemAutomationAttempt(client, item.id));
    expect(again?.attempts).toBe(2);
  });

  it("startItemAutomationAttempt returns null and changes nothing on a locked or absent row (issue #248)", async () => {
    const booksId = await getDatabaseIdByModule("books");
    const item = await inTenantZero(() => chokePoint.createItem({ databaseId: booksId, properties: { name: "Dune" } }));
    await withTransaction(pool, (client) => ensureItemAutomation(client, item.id));
    await withTransaction(pool, (client) => setItemAutomationLocked(client, item.id, true));

    expect(await withTransaction(pool, (client) => startItemAutomationAttempt(client, item.id))).toBeNull();
    const locked = await withTransaction(pool, (client) => getItemAutomation(client, item.id));
    expect(locked).toMatchObject({ status: "locked", attempts: 0, lastAttemptAt: null });

    const absentId = "00000000-0000-4000-8000-000000000000";
    expect(await withTransaction(pool, (client) => startItemAutomationAttempt(client, absentId))).toBeNull();
  });

  it("recordItemAutomationFailure writes the error and status without counting an attempt, and never touches a locked row (issue #248)", async () => {
    const booksId = await getDatabaseIdByModule("books");
    const item = await inTenantZero(() => chokePoint.createItem({ databaseId: booksId, properties: { name: "Dune" } }));
    await withTransaction(pool, (client) => ensureItemAutomation(client, item.id));

    expect(
      await withTransaction(pool, (client) => recordItemAutomationFailure(client, item.id, "transient", "pending")),
    ).toBe(true);
    expect(await withTransaction(pool, (client) => getItemAutomation(client, item.id))).toMatchObject({
      status: "pending",
      error: "transient",
      attempts: 0,
    });

    expect(
      await withTransaction(pool, (client) => recordItemAutomationFailure(client, item.id, "permanent", "error")),
    ).toBe(true);
    expect(await withTransaction(pool, (client) => getItemAutomation(client, item.id))).toMatchObject({
      status: "error",
      error: "permanent",
      attempts: 0,
    });

    await withTransaction(pool, (client) => setItemAutomationLocked(client, item.id, true));
    expect(
      await withTransaction(pool, (client) => recordItemAutomationFailure(client, item.id, "ignored", "error")),
    ).toBe(false);
    expect(await withTransaction(pool, (client) => getItemAutomation(client, item.id))).toMatchObject({
      status: "locked",
      error: "permanent",
    });
  });

  it("unlocking a row only transitions it if it was actually locked, never clobbering 'done'/'error'", async () => {
    const booksId = await getDatabaseIdByModule("books");
    const item = await inTenantZero(() => chokePoint.createItem({ databaseId: booksId, properties: { name: "Dune" } }));

    await withTransaction(pool, (client) => ensureItemAutomation(client, item.id));
    await withTransaction(pool, (client) => markItemAutomationDone(client, item.id));

    // Unlocking a row that was never locked (already 'done') is a no-op, not a reset to 'pending'.
    const unlocked = await withTransaction(pool, (client) => setItemAutomationLocked(client, item.id, false));
    expect(unlocked.status).toBe("done");

    // Locking then unlocking does reach 'pending' — the one real lock/unlock transition.
    await withTransaction(pool, (client) => setItemAutomationLocked(client, item.id, true));
    const relocked = await withTransaction(pool, (client) => getItemAutomation(client, item.id));
    expect(relocked?.status).toBe("locked");
    const reunlocked = await withTransaction(pool, (client) => setItemAutomationLocked(client, item.id, false));
    expect(reunlocked.status).toBe("pending");
  });
});

describe("library automation_error recipient in a tenant (issue #1018)", () => {
  let runtimePool: Pool;

  // The first describe's `afterAll` ended the shared pool, so this block opens and closes its own.
  beforeAll(async () => {
    pool = getTestPool();
    runtimePool = await runInTenant(getTenantZeroId(), () => createRuntimeRolePool(pool, "semprec_data"));
  });

  beforeEach(async () => {
    await runInTenant(getTenantZeroId(), () => resetDatabase(pool));
  });

  afterAll(async () => {
    await runtimePool?.end();
    await pool?.end();
  });

  it("notifies the user of the tenant the fetch fails in, never the earlier-created account", async () => {
    const tenantB = await runInTenant(getTenantZeroId(), () => createTestTenant(pool));
    const userA = await runInTenant(getTenantZeroId(), () =>
      createUser(pool, { email: "a@example.test", passwordHash: "x", tenantId: getTenantZeroId() }),
    );
    const userB = await runInTenant(tenantB, () =>
      createUser(pool, { email: "b@example.test", passwordHash: "x", tenantId: tenantB }),
    );
    const { itemId, moviesId } = await runInTenant(tenantB, async () => {
      await seedSystem(runtimePool);
      const { rows } = await runtimePool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [
        "movies",
      ]);
      const databaseId = rows[0]!.id;
      const item = await createChokePoint(runtimePool).createItem({
        databaseId,
        properties: { name: "Sicario", year: 2015 },
      });
      return { itemId: item.id, moviesId: databaseId };
    });
    const failingFetcher: LibraryMetadataFetcher = async () => {
      throw new Error("source unavailable");
    };

    await expect(
      runInTenant(tenantB, () =>
        handleProcessLibraryMetadataTask(
          runtimePool,
          { itemId, databaseId: moviesId, config: { source: "test", coverKey: "cover" } },
          failingFetcher,
          { job: { id: "job-b" } },
        ),
      ),
    ).rejects.toThrow("Library metadata processing failed");

    const { rows } = await pool.query<{ user_id: string; kind: string; tenant_id: string }>(
      `SELECT user_id, kind, tenant_id FROM notifications WHERE source_id = $1`,
      [itemId],
    );
    expect(rows).toEqual([{ user_id: userB.id, kind: "automation_error", tenant_id: tenantB }]);
    expect(rows[0]?.user_id).not.toBe(userA.id);
  });
});

describe("Books year and ISBN tenant cutover", () => {
  let admin: Pool;
  let runtime: Pool;
  let tenantId: string;
  let booksId: string;
  beforeEach(async () => {
    admin ??= getTestPool();
    runtime ??= await createRuntimeRolePool(admin, "semprec_data");
    await resetDatabase(admin);
    tenantId = await createTestTenant(admin);
    await runInTenant(tenantId, async () => {
      await seedSystem(runtime);
      const { rows } = await runtime.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = 'books'");
      if (!rows[0]) throw new Error("Books missing");
      booksId = rows[0].id;
    });
  });
  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  async function snapshot() {
    const { rows } = await runtime.query<{
      key: string;
      type: string;
      owner: string;
      name: string | null;
      xmin: string;
      id: string;
    }>("SELECT key, type, owner, name, xmin::text AS xmin, id FROM properties WHERE database_id = $1 ORDER BY key", [
      booksId,
    ]);
    return rows;
  }
  it("upgrades the populated tenant through the registered runner without changing another tenant", async () => {
    const other = await createTestTenant(admin);
    await runInTenant(other, () => seedSystem(runtime));
    const oldConfig = async () =>
      runtime.query(
        `UPDATE project_heartbeats SET action_config = (action_config - 'authorKey' - 'yearKey' - 'isbnKey' - 'typeKey') || '{"source":"none"}'::jsonb
       WHERE action_id = ANY($1::text[])`,
        [[LIBRARY_METADATA_TRIGGER_ACTION_ID, LIBRARY_METADATA_RETRY_SWEEP_ACTION_ID]],
      );
    const snapshotConfigs = async () =>
      (
        await runtime.query<{ id: string; action_config: Record<string, unknown>; xmin: string }>(
          `SELECT id, action_config, xmin::text FROM project_heartbeats WHERE action_id = ANY($1::text[]) ORDER BY id`,
          [[LIBRARY_METADATA_TRIGGER_ACTION_ID, LIBRARY_METADATA_RETRY_SWEEP_ACTION_ID]],
        )
      ).rows;
    await runInTenant(tenantId, oldConfig);
    await runInTenant(other, oldConfig);
    const otherBefore = await runInTenant(other, snapshotConfigs);
    await runInTenant(tenantId, () => runLibraryHeartbeatConfigCutoverMigration(runtime));
    const scoped = await runInTenant(tenantId, snapshotConfigs);
    expect(scoped).toHaveLength(4);
    expect(scoped.filter((row) => row.action_config.source === "openLibrary")).toHaveLength(2);
    expect(scoped.filter((row) => row.action_config.source === "tmdb")).toHaveLength(2);
    expect(await runInTenant(other, snapshotConfigs)).toEqual(otherBefore);
    await runAsSystem("test registered library heartbeat cutover", () => runTenantCutoverMigrations(runtime));
    const otherAfter = await runInTenant(other, snapshotConfigs);
    expect(otherAfter.filter((row) => row.action_config.source === "openLibrary")).toHaveLength(2);
    expect(otherAfter.filter((row) => row.action_config.source === "tmdb")).toHaveLength(2);
    await runAsSystem("test registered library heartbeat cutover again", () => runTenantCutoverMigrations(runtime));
    expect(await runInTenant(other, snapshotConfigs)).toEqual(otherAfter);
    expect(await runInTenant(tenantId, snapshotConfigs)).toEqual(scoped);
  });

  it("seeds both Books fields for a fresh tenant through the runtime role", async () =>
    runInTenant(tenantId, async () => {
      const properties = await snapshot();
      expect(properties.find((property) => property.key === "year")).toMatchObject({
        type: "number",
        owner: "user",
        name: null,
      });
      expect(properties.find((property) => property.key === "isbn")).toMatchObject({
        type: "text",
        owner: "user",
        name: null,
      });
    }));
  it("runs the registered cutover on a populated tenant and leaves it unchanged on a second run", async () => {
    await runInTenant(tenantId, async () => {
      // Recreate the older schema shape; the current seed always creates both properties.
      await runtime.query("DELETE FROM properties WHERE database_id = $1 AND key = ANY($2::text[])", [
        booksId,
        ["year", "isbn"],
      ]);
    });
    const run = () => runAsSystem("test Books cutover", () => runTenantCutoverMigrations(runtime));
    await run();
    const upgraded = await runInTenant(tenantId, snapshot);
    expect(upgraded.find((property) => property.key === "year")).toMatchObject({ type: "number", owner: "user" });
    expect(upgraded.find((property) => property.key === "isbn")).toMatchObject({ type: "text", owner: "user" });
    await run();
    expect(await runInTenant(tenantId, snapshot)).toEqual(upgraded);
  });
  it("adds both missing properties to the locked schema once and preserves existing properties", async () =>
    runInTenant(tenantId, async () => {
      // Direct fixture SQL recreates the schema of an older build.
      await runtime.query("DELETE FROM properties WHERE database_id = $1 AND key = ANY($2::text[])", [
        booksId,
        ["year", "isbn"],
      ]);
      const before = await snapshot();
      await runLibraryBooksYearIsbnCutoverMigration(runtime);
      const upgraded = await snapshot();
      expect(upgraded.filter((p) => p.key !== "year" && p.key !== "isbn")).toEqual(before);
      expect(upgraded.find((p) => p.key === "year")).toMatchObject({ type: "number", owner: "user", name: null });
      expect(upgraded.find((p) => p.key === "isbn")).toMatchObject({ type: "text", owner: "user", name: null });
      await runLibraryBooksYearIsbnCutoverMigration(runtime);
      expect(await snapshot()).toEqual(upgraded);
      const db = await runtime.query<{ schema_locked: boolean }>("SELECT schema_locked FROM databases WHERE id = $1", [
        booksId,
      ]);
      expect(db.rows[0]?.schema_locked).toBe(true);
    }));
  it.each(["year", "isbn"])(
    "preserves an existing %s property when adding its missing neighbour",
    async (existingKey) =>
      runInTenant(tenantId, async () => {
        await runtime.query("DELETE FROM properties WHERE database_id = $1 AND key = $2", [
          booksId,
          existingKey === "year" ? "isbn" : "year",
        ]);
        const existing = (await snapshot()).find((p) => p.key === existingKey);
        await runLibraryBooksYearIsbnCutoverMigration(runtime);
        const result = await snapshot();
        expect(result.find((p) => p.key === existingKey)).toEqual(existing);
        expect(result.map((p) => p.key)).toContain(existingKey === "year" ? "isbn" : "year");
      }),
  );
  it("stores numeric year and text ISBN through the choke point and refuses text year on create and update", async () =>
    runInTenant(tenantId, async () => {
      const api = createChokePoint(runtime);
      const item = await api.createItem({
        databaseId: booksId,
        properties: { name: "Book", year: 2019, isbn: "9788074325014" },
      });
      expect((await api.getItem(booksId, item.id))?.properties).toMatchObject({ year: 2019, isbn: "9788074325014" });
      await expect(
        api.createItem({ databaseId: booksId, properties: { name: "Invalid", year: "2019" } }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        api.updateItem({ databaseId: booksId, itemId: item.id, propertiesPatch: { year: "2019" } }),
      ).rejects.toBeInstanceOf(ValidationError);
      await api.updateItem({
        databaseId: booksId,
        itemId: item.id,
        propertiesPatch: { year: 2020, isbn: "9788074325015" },
      });
      expect((await api.getItem(booksId, item.id))?.properties).toMatchObject({ year: 2020, isbn: "9788074325015" });
    }));
  it("resolves both names through the real Czech and English schema projection", async () =>
    runInTenant(tenantId, async () => {
      const registry = await loadFullModuleRegistry();
      for (const locale of ["cs", "en"] as const) {
        const schema = await withTransaction(runtime, (client) =>
          generateSchemaProjection(client, registry, { locale }),
        );
        const properties = schema.databases.find((db) => db.databaseId === booksId)?.properties;
        expect(properties?.find((p) => p.key === "year")?.name).toBe(locale === "cs" ? "Rok" : "Year");
        expect(properties?.find((p) => p.key === "isbn")?.name).toBe("ISBN");
      }
    }));
  it("does not change another tenant and skips a tenant without Books", async () => {
    const empty = await createTestTenant(admin);
    await runInTenant(tenantId, async () => {
      await runtime.query("DELETE FROM properties WHERE database_id = $1 AND key = ANY($2::text[])", [
        booksId,
        ["year", "isbn"],
      ]);
    });
    await runInTenant(empty, () => runLibraryBooksYearIsbnCutoverMigration(runtime));
    await runInTenant(tenantId, async () => {
      expect((await snapshot()).map((p) => p.key)).not.toContain("year");
    });
  });
});
