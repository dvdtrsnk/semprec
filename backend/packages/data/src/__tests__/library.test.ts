import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, enqueueJob, runOnce, runWorker } from "@semprec/queue";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createLibraryMetadataFetcher } from "../library/libraryMetadataFetcher.js";
import { LibraryMetadataConfigurationError } from "../library/libraryMetadataConfig.js";
import { downloadLibraryCover } from "../library/openLibraryFetcher.js";
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
  stubDnsLookup,
} from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { createBlob, tenantBlobStorageKey } from "../blobs/blobsStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import { LocalFsBlobStorageWriter, type BlobStorageWriter } from "../mail/blobStorage.js";
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
  markItemAutomationError,
  markItemAutomationNotFound,
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

const coverTransport = vi.hoisted(() => ({ active: false, urls: [] as string[] }));
vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return {
    ...actual,
    async fetch(...args: Parameters<typeof actual.fetch>) {
      const input = args[0];
      const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
      if (
        coverTransport.active &&
        ["covers.openlibrary.org", "image.tmdb.org", "google-cover.invalid"].includes(url.hostname)
      ) {
        coverTransport.urls.push(url.toString());
        return new actual.Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), {
          headers: { "content-type": "image/jpeg" },
        });
      }
      return actual.fetch(...args);
    },
  };
});

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

  it("preserves a user's movie year and type while applying source metadata", async () => {
    const databaseId = await getDatabaseIdByModule("movies");
    const item = await inTenantZero(() =>
      chokePoint.createItem({
        databaseId,
        properties: { name: "Film", year: 1999, type: "series" },
      }),
    );
    await withTransaction(pool, (client) => ensureItemAutomation(client, item.id));
    await inTenantZero(() =>
      handleProcessLibraryMetadataTask(
        pool,
        {
          itemId: item.id,
          databaseId,
          config: {
            source: "tmdb",
            coverKey: "cover",
            typeKey: "type",
            yearKey: "year",
            secondaryRatingKey: "secondaryRating",
          },
        },
        async () => ({ status: "found", source: "tmdb", type: "movie", year: 2024, secondaryRating: 79 }),
      ),
    );
    expect((await chokePoint.getItem(databaseId, item.id))?.properties).toMatchObject({
      year: 1999,
      type: "series",
      secondaryRating: 79,
    });
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

  it("rejects unsupported source before fetching, creating automation or enqueueing", async () => {
    const databaseId = await getDatabaseIdByModule("books");
    const item = await inTenantZero(() => chokePoint.createItem({ databaseId, properties: { name: "Book" } }));
    const config = { databaseId, source: "unsupported-private-value", coverKey: "cover" };
    const context = { heartbeatId: "heartbeat", projectItemId: "project", itemId: item.id };
    const error = "Unsupported library metadata source configuration";
    const fetcher = createLibraryMetadataFetcher({
      fetch: async () => {
        throw new Error("Unexpected fetch");
      },
    });
    await expect(fetcher(item, config)).rejects.toThrow(error);
    await expect(
      inTenantZero(() =>
        withTransaction(pool, (client) =>
          enqueueLibraryMetadataProcessing(client, { itemId: item.id, databaseId, config }),
        ),
      ),
    ).rejects.toThrow(error);
    await expect(createLibraryMetadataTriggerAction(pool)(config, context)).rejects.toThrow(error);
    await expect(createLibraryMetadataRetrySweepAction(pool)(config, context)).rejects.toThrow(error);
    expect(await withTransaction(pool, (client) => getItemAutomation(client, item.id))).toBeNull();
    const { rows } = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM graphile_worker.jobs WHERE key = $1",
      [`library-metadata:${item.id}`],
    );
    expect(rows[0]?.count).toBe("0");
  });

  it("rejects a legacy invalid queued job without altering its existing automation", async () => {
    const databaseId = await getDatabaseIdByModule("books");
    const item = await inTenantZero(() => chokePoint.createItem({ databaseId, properties: { name: "Book" } }));
    await withTransaction(pool, (client) => ensureItemAutomation(client, item.id));
    const before = await withTransaction(pool, (client) => getItemAutomation(client, item.id));
    let invoked = false;
    await expect(
      inTenantZero(() =>
        handleProcessLibraryMetadataTask(
          pool,
          { itemId: item.id, databaseId, config: { source: "bad", coverKey: "cover" } },
          async () => {
            invoked = true;
            return {};
          },
        ),
      ),
    ).rejects.toThrow("Unsupported library metadata source configuration");
    expect(invoked).toBe(false);
    expect(await withTransaction(pool, (client) => getItemAutomation(client, item.id))).toEqual(before);
  });

  it("preserves a recognized downstream configuration refusal without recording an outcome", async () => {
    const databaseId = await getDatabaseIdByModule("books");
    const item = await inTenantZero(() => chokePoint.createItem({ databaseId, properties: { name: "Book" } }));
    await withTransaction(pool, (client) => ensureItemAutomation(client, item.id));
    const before = await withTransaction(pool, (client) => getItemAutomation(client, item.id));
    const failure = new LibraryMetadataConfigurationError();
    await expect(
      inTenantZero(() =>
        handleProcessLibraryMetadataTask(
          pool,
          { itemId: item.id, databaseId, config: { source: "openLibrary", coverKey: "cover" } },
          async () => {
            throw failure;
          },
        ),
      ),
    ).rejects.toBe(failure);
    expect(await withTransaction(pool, (client) => getItemAutomation(client, item.id))).toEqual(before);
  });

  it("bounds a queued legacy unsupported source to its existing three attempts", async () => {
    const databaseId = await getDatabaseIdByModule("books");
    const item = await inTenantZero(() => chokePoint.createItem({ databaseId, properties: { name: "Book" } }));
    await inTenantZero(() =>
      withTransaction(pool, async (client) => {
        await ensureItemAutomation(client, item.id);
        await enqueueJob(
          client,
          CORE_TASK_NAMES.LIBRARY_METADATA_PROCESS,
          { itemId: item.id, databaseId, config: { source: "legacy-invalid", coverKey: "cover" } },
          { jobKey: `library-metadata:${item.id}`, maxAttempts: 3 },
        );
      }),
    );
    const before = await withTransaction(pool, (client) => getItemAutomation(client, item.id));
    const name = CORE_TASK_NAMES.LIBRARY_METADATA_PROCESS;
    const handler = createCoreTaskList(pool, libraryRegistry())[name];
    if (!handler) throw new Error("Metadata task missing");
    const worker = await runWorker({
      pgPool: pool,
      taskList: { [name]: handler },
      noHandleSignals: true,
      concurrency: 1,
    });
    const failures: unknown[] = [];
    try {
      const deadline = Date.now() + 30000;
      let complete = false;
      while (Date.now() < deadline) {
        const jobs = await pool.query<{ attempts: number; max_attempts: number; locked_at: Date | null }>(
          "SELECT attempts, max_attempts, locked_at FROM graphile_worker.jobs WHERE key = $1",
          [`library-metadata:${item.id}`],
        );
        if (jobs.rows[0]?.attempts === 3 && jobs.rows[0].max_attempts === 3 && jobs.rows[0].locked_at === null) {
          complete = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(complete).toBe(true);
      expect(await withTransaction(pool, (client) => getItemAutomation(client, item.id))).toEqual(before);
    } catch (error) {
      failures.push(error);
    }
    try {
      await worker.stop();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Legacy metadata test and cleanup failed");
  }, 35000);

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

  it("creating a library item drives metadata and stores actual cover bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "semprec-library-cover-"));
    try {
      const storage = new LocalFsBlobStorageWriter(root);
      const booksId = await getDatabaseIdByModule("books");
      const registry = libraryRegistry();
      const item = await inTenantZero(() =>
        chokePoint.createItem({
          databaseId: booksId,
          properties: { name: "Dune", author: "Frank Herbert" },
        }),
      );
      const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
      const fetcher: LibraryMetadataFetcher = async () => ({ cover: { mimeType: "image/jpeg", bytes } });
      await runOnce({
        pgPool: pool,
        taskList: createCoreTaskList(
          pool,
          registry,
          fetcher,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          storage,
        ),
      });
      const updated = await chokePoint.getItem(booksId, item.id);
      const reference = z.object({ blobId: z.uuid() }).parse(updated?.properties.cover);
      const { rows } = await pool.query<{ storage_key: string }>("SELECT storage_key FROM blobs WHERE id = $1", [
        reference.blobId,
      ]);
      expect(rows).toHaveLength(1);
      expect(await readFile(join(root, z.string().parse(rows[0]?.storage_key)))).toEqual(bytes);
      expect((await withTransaction(pool, (client) => getItemAutomation(client, item.id)))?.status).toBe("done");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("downloads a Google fallback cover with a query without exposing that URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "semprec-google-cover-"));
    const failures: unknown[] = [];
    try {
      const books = await getDatabaseIdByModule("books");
      const book = await inTenantZero(() => chokePoint.createItem({ databaseId: books, properties: { name: "Book" } }));
      await withTransaction(pool, (client) => ensureItemAutomation(client, book.id));
      const coverUrl = "https://google-cover.invalid/image?id=fixture-secret";
      const fetcher = createLibraryMetadataFetcher({
        fetch: async (url) =>
          new Response(
            JSON.stringify(
              url.startsWith("https://openlibrary.org/")
                ? { docs: [] }
                : {
                    kind: "books#volumes",
                    totalItems: 2,
                    items: [
                      { volumeInfo: { title: "Book", imageLinks: { thumbnail: coverUrl } } },
                      { volumeInfo: { title: "Other", imageLinks: { thumbnail: coverUrl } } },
                    ],
                  },
            ),
          ),
      });
      coverTransport.urls.length = 0;
      coverTransport.active = true;
      const stored = await chokePoint.getItem(books, book.id);
      if (!stored) throw new Error("Missing book fixture");
      const result = await fetcher(stored, { source: "openLibrary", coverKey: "cover" });
      expect(result.status).toBe("found");
      expect(result.source).toBe("googleBooks");
      expect(result.cover?.bytes).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      expect(JSON.stringify(result)).not.toContain("fixture-secret");
      await inTenantZero(() =>
        handleProcessLibraryMetadataTask(
          pool,
          { itemId: book.id, databaseId: books, config: { source: "openLibrary", coverKey: "cover" } },
          fetcher,
          undefined,
          new LocalFsBlobStorageWriter(root),
        ),
      );
      expect(coverTransport.urls).toEqual([coverUrl, coverUrl]);
      const after = await chokePoint.getItem(books, book.id);
      const reference = z.object({ blobId: z.uuid() }).parse(after?.properties.cover);
      const rows = await pool.query<{ storage_key: string }>("SELECT storage_key FROM blobs WHERE id = $1", [
        reference.blobId,
      ]);
      expect(rows.rows).toHaveLength(1);
      expect(await readFile(join(root, rows.rows[0]!.storage_key))).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    } catch (error) {
      failures.push(error);
    }
    coverTransport.active = false;
    coverTransport.urls.length = 0;
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Google cover test and cleanup failed");
  });

  it("applies book and movie provider fixtures through the job and real cover owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "semprec-library-provider-covers-"));
    const storage = new LocalFsBlobStorageWriter(root);
    const failures: unknown[] = [];
    try {
      const books = await getDatabaseIdByModule("books");
      const movies = await getDatabaseIdByModule("movies");
      const book = await inTenantZero(() =>
        chokePoint.createItem({ databaseId: books, properties: { name: "Hovory k sobě" } }),
      );
      const movie = await inTenantZero(() =>
        chokePoint.createItem({ databaseId: movies, properties: { name: "Duna: Část druhá" } }),
      );
      for (const item of [book, movie]) await withTransaction(pool, (client) => ensureItemAutomation(client, item.id));
      const fetcher = createLibraryMetadataFetcher({
        tmdbToken: "fixture-token",
        fetch: async (url) => {
          if (url.startsWith("https://openlibrary.org/"))
            return new Response(
              JSON.stringify({
                docs: [
                  {
                    title: "Hovory k sobě",
                    author_name: ["Marcus Aurelius"],
                    first_publish_year: 180,
                    isbn: ["9780000000000"],
                    cover_i: 123,
                  },
                ],
              }),
            );
          if (url.includes("/search/multi"))
            return new Response(
              JSON.stringify({
                results: [
                  {
                    id: 1,
                    media_type: "movie",
                    title: "Duna: Část druhá",
                    release_date: "2024-02-28",
                    poster_path: "/fixture.jpg",
                  },
                ],
              }),
            );
          if (url.endsWith("/movie/1")) return new Response(JSON.stringify({ vote_average: 7.9, vote_count: 30 }));
          throw new Error("Unexpected provider fixture URL");
        },
      });
      coverTransport.urls.length = 0;
      coverTransport.active = true;
      await inTenantZero(() =>
        handleProcessLibraryMetadataTask(
          pool,
          {
            itemId: book.id,
            databaseId: books,
            config: { source: "openLibrary", coverKey: "cover", authorKey: "author", yearKey: "year", isbnKey: "isbn" },
          },
          fetcher,
          undefined,
          storage,
        ),
      );
      await inTenantZero(() =>
        handleProcessLibraryMetadataTask(
          pool,
          {
            itemId: movie.id,
            databaseId: movies,
            config: {
              source: "tmdb",
              coverKey: "cover",
              yearKey: "year",
              typeKey: "type",
              secondaryRatingKey: "secondaryRating",
              sourceUrlKey: "sourceUrl",
            },
          },
          fetcher,
          undefined,
          storage,
        ),
      );
      expect(coverTransport.urls).toEqual([
        "https://covers.openlibrary.org/b/id/123-L.jpg",
        "https://image.tmdb.org/t/p/w500/fixture.jpg",
      ]);
      const storedBook = await chokePoint.getItem(books, book.id);
      const storedMovie = await chokePoint.getItem(movies, movie.id);
      expect(storedBook?.properties).toMatchObject({ author: "Marcus Aurelius", year: 180, isbn: "9780000000000" });
      expect(storedMovie?.properties).toMatchObject({
        year: 2024,
        type: "movie",
        secondaryRating: 79,
        sourceUrl: "https://www.themoviedb.org/movie/1",
      });
      for (const item of [storedBook, storedMovie]) {
        const reference = z.object({ blobId: z.uuid() }).parse(item?.properties.cover);
        const row = await pool.query<{ storage_key: string }>("SELECT storage_key FROM blobs WHERE id = $1", [
          reference.blobId,
        ]);
        expect(row.rows).toHaveLength(1);
        expect(await readFile(join(root, row.rows[0]!.storage_key))).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      }
    } catch (error) {
      failures.push(error);
    }
    coverTransport.active = false;
    coverTransport.urls.length = 0;
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Provider cover test and cleanup failed");
  });

  it.each(["169.254.169.254", "10.0.0.1"])("refuses a cover hostname resolving to %s", async (address) => {
    const dns = stubDnsLookup({ "private-cover.invalid": [address], "image.tmdb.org": [address] });
    try {
      expect(await downloadLibraryCover("https://private-cover.invalid/cover.jpg")).toBeUndefined();
      expect(dns.calls).toContain("private-cover.invalid");
      const books = await getDatabaseIdByModule("books");
      const book = await inTenantZero(() => chokePoint.createItem({ databaseId: books, properties: { name: "Book" } }));
      await withTransaction(pool, (client) => ensureItemAutomation(client, book.id));
      const before = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM blobs");
      const fetcher = createLibraryMetadataFetcher({
        fetch: async (url) =>
          new Response(
            JSON.stringify(
              url.startsWith("https://openlibrary.org/")
                ? { docs: [] }
                : {
                    kind: "books#volumes",
                    totalItems: 1,
                    items: [
                      {
                        volumeInfo: {
                          title: "Book",
                          authors: ["Fixture Author"],
                          imageLinks: { thumbnail: "https://private-cover.invalid/cover.jpg" },
                        },
                      },
                    ],
                  },
            ),
          ),
      });
      await inTenantZero(() =>
        handleProcessLibraryMetadataTask(
          pool,
          {
            itemId: book.id,
            databaseId: books,
            config: { source: "openLibrary", coverKey: "cover", authorKey: "author" },
          },
          fetcher,
        ),
      );
      const result = await chokePoint.getItem(books, book.id);
      expect(result?.properties.author).toBe("Fixture Author");
      expect(result?.properties.cover).toBeUndefined();
      expect(dns.calls.filter((host) => host === "private-cover.invalid")).toHaveLength(2);
      const after = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM blobs");
      expect(after.rows).toEqual(before.rows);
      const movies = await getDatabaseIdByModule("movies");
      const movie = await inTenantZero(() =>
        chokePoint.createItem({ databaseId: movies, properties: { name: "Film" } }),
      );
      await withTransaction(pool, (client) => ensureItemAutomation(client, movie.id));
      const movieFetcher = createLibraryMetadataFetcher({
        tmdbToken: "fixture-token",
        fetch: async (url) =>
          new Response(
            JSON.stringify(
              url.includes("/search/multi")
                ? {
                    results: [
                      {
                        id: 1,
                        media_type: "movie",
                        title: "Film",
                        release_date: "2024-01-01",
                        poster_path: "/fixture.jpg",
                      },
                    ],
                  }
                : { vote_average: 7.9, vote_count: 10 },
            ),
          ),
      });
      await inTenantZero(() =>
        handleProcessLibraryMetadataTask(
          pool,
          {
            itemId: movie.id,
            databaseId: movies,
            config: {
              source: "tmdb",
              coverKey: "cover",
              yearKey: "year",
              typeKey: "type",
              secondaryRatingKey: "secondaryRating",
            },
          },
          movieFetcher,
        ),
      );
      const movieResult = await chokePoint.getItem(movies, movie.id);
      expect(movieResult?.properties).toMatchObject({ year: 2024, type: "movie", secondaryRating: 79 });
      expect(movieResult?.properties.cover).toBeUndefined();
      expect(dns.calls).toContain("image.tmdb.org");
      expect((await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM blobs")).rows).toEqual(
        before.rows,
      );
    } finally {
      dns.restore();
    }
  });

  it("keeps canonical deduplicated cover bytes and removes staged bytes on rollback", async () => {
    const root = await mkdtemp(join(tmpdir(), "semprec-library-cover-dedup-"));
    try {
      const local = new LocalFsBlobStorageWriter(root);
      const written: string[] = [];
      const removed: string[] = [];
      const storage: BlobStorageWriter = {
        async writeStream(key, source, options) {
          const result = await local.writeStream(key, source, options);
          written.push(key);
          return result;
        },
        async delete(key) {
          removed.push(key);
          await local.delete(key);
        },
        readStream: (key, range) => local.readStream(key, range),
      };
      const books = await getDatabaseIdByModule("books");
      const items = await inTenantZero(() =>
        Promise.all(
          ["One", "Two", "Rollback", "Locked during fetch"].map((name) =>
            chokePoint.createItem({ databaseId: books, properties: { name } }),
          ),
        ),
      );
      const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
      const fetcher: LibraryMetadataFetcher = async () => ({
        status: "found",
        source: "openLibrary",
        cover: { mimeType: "image/jpeg", bytes },
      });
      for (const item of items) await withTransaction(pool, (client) => ensureItemAutomation(client, item.id));
      for (const item of items.slice(0, 2))
        await inTenantZero(() =>
          handleProcessLibraryMetadataTask(
            pool,
            { itemId: item.id, databaseId: books, config: { source: "openLibrary", coverKey: "cover" } },
            fetcher,
            undefined,
            storage,
          ),
        );
      const first = await chokePoint.getItem(books, items[0]!.id);
      const second = await chokePoint.getItem(books, items[1]!.id);
      const canonical = z.object({ blobId: z.uuid() }).parse(first?.properties.cover);
      expect(second?.properties.cover).toEqual(canonical);
      expect(written).toHaveLength(2);
      expect(removed).toEqual([written[1]]);
      expect(await readFile(join(root, written[0]!))).toEqual(bytes);
      await expect(
        inTenantZero(() =>
          handleProcessLibraryMetadataTask(
            pool,
            { itemId: items[2]!.id, databaseId: books, config: { source: "openLibrary", coverKey: "missingProperty" } },
            async () => ({ status: "found", cover: { mimeType: "image/jpeg", bytes: Buffer.from([1, 2, 3]) } }),
            undefined,
            storage,
          ),
        ),
      ).rejects.toThrow("Library metadata processing failed");
      expect(written).toHaveLength(3);
      expect(removed).toEqual([written[1], written[2]]);
      expect(await readFile(join(root, written[0]!))).toEqual(bytes);
      expect((await chokePoint.getItem(books, items[2]!.id))?.properties).not.toHaveProperty("missingProperty");
      await inTenantZero(() =>
        handleProcessLibraryMetadataTask(
          pool,
          { itemId: items[3]!.id, databaseId: books, config: { source: "openLibrary", coverKey: "cover" } },
          async () => {
            await withTransaction(pool, (client) => setItemAutomationLocked(client, items[3]!.id, true));
            return { status: "found", cover: { mimeType: "image/jpeg", bytes } };
          },
          undefined,
          storage,
        ),
      );
      expect(written).toHaveLength(4);
      expect(removed).toEqual([written[1], written[2], written[3]]);
      expect((await chokePoint.getItem(books, items[3]!.id))?.properties.cover).toBeUndefined();
      expect((await withTransaction(pool, (client) => getItemAutomation(client, items[3]!.id)))?.status).toBe("locked");
      expect(await readFile(join(root, written[0]!))).toEqual(bytes);
      const rows = await pool.query<{ storage_key: string }>(
        "SELECT storage_key FROM blobs WHERE storage_key = ANY($1::text[])",
        [written],
      );
      expect(rows.rows).toEqual([{ storage_key: written[0] }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves deduplicated bytes owned by the other storage root", async () => {
    const filesRoot = await mkdtemp(join(tmpdir(), "semprec-library-files-root-"));
    const mailRoot = await mkdtemp(join(tmpdir(), "semprec-library-mail-root-"));
    const failures: unknown[] = [];
    try {
      const files = new LocalFsBlobStorageWriter(filesRoot);
      const mail = new LocalFsBlobStorageWriter(mailRoot);
      const removed: string[] = [];
      const storage: BlobStorageWriter = {
        writeStream: (...args) => files.writeStream(...args),
        async delete(key) {
          removed.push(key);
          await files.delete(key);
        },
        readStream: (key, range) => files.readStream(key, range),
      };
      const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
      const key = await inTenantZero(() => tenantBlobStorageKey(pool, "mail/fixture-cover.jpg"));
      const written = await mail.writeStream(key, Readable.from([bytes]));
      const canonical = await inTenantZero(() =>
        withTransaction(pool, (client) =>
          createBlob(client, {
            mimeType: "image/jpeg",
            storageKey: key,
            ...written,
          }),
        ),
      );
      const books = await getDatabaseIdByModule("books");
      const book = await inTenantZero(() => chokePoint.createItem({ databaseId: books, properties: { name: "Book" } }));
      await withTransaction(pool, (client) => ensureItemAutomation(client, book.id));
      await inTenantZero(() =>
        handleProcessLibraryMetadataTask(
          pool,
          { itemId: book.id, databaseId: books, config: { source: "openLibrary", coverKey: "cover" } },
          async () => ({ status: "found", cover: { mimeType: "image/jpeg", bytes } }),
          undefined,
          storage,
        ),
      );
      expect((await chokePoint.getItem(books, book.id))?.properties.cover).toEqual({ blobId: canonical.id });
      expect(removed).toHaveLength(1);
      expect(removed[0]).not.toBe(key);
      expect(await readFile(join(mailRoot, key))).toEqual(bytes);
      const row = await pool.query<{ storage_key: string }>("SELECT storage_key FROM blobs WHERE id = $1", [
        canonical.id,
      ]);
      expect(row.rows).toEqual([{ storage_key: key }]);
    } catch (error) {
      failures.push(error);
    }
    for (const root of [filesRoot, mailRoot]) {
      try {
        await rm(root, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Cross-root cover test and cleanup failed");
  });

  it.each(["release", "commit"] as const)(
    "retains committed cover bytes when the transaction %s acknowledgement fails",
    async (failurePoint) => {
      const root = await mkdtemp(join(tmpdir(), "semprec-library-cover-commit-"));
      const storage = new LocalFsBlobStorageWriter(root);
      const failures: unknown[] = [];
      const originals = new Map<
        PoolClient,
        { query: PropertyDescriptor | undefined; release: PropertyDescriptor | undefined }
      >();
      let injected = false;
      const onAcquire = (client: PoolClient) => {
        if (!originals.has(client)) {
          const queryDescriptor = Object.getOwnPropertyDescriptor(client, "query");
          const releaseDescriptor = Object.getOwnPropertyDescriptor(client, "release");
          // eslint-disable-next-line @typescript-eslint/unbound-method
          const query = client.query;
          originals.set(client, { query: queryDescriptor, release: releaseDescriptor });
          Object.defineProperty(client, "query", {
            configurable: true,
            writable: true,
            value: (...args: unknown[]) => {
              const result: unknown = Reflect.apply(query, client, args);
              if (args[0] !== "COMMIT" || injected) return result;
              if (!(result instanceof Promise)) throw new Error("Expected asynchronous commit");
              return result.then((value: unknown) => {
                if (failurePoint === "commit" && !injected) {
                  injected = true;
                  throw new Error("commit acknowledgement failed");
                }
                if (failurePoint === "release" && !injected) {
                  // The pool assigns release after its acquire event, so observe it here.
                  // eslint-disable-next-line @typescript-eslint/unbound-method
                  const release = client.release;
                  Object.defineProperty(client, "release", {
                    configurable: true,
                    writable: true,
                    value: (...releaseArgs: unknown[]) => {
                      Reflect.apply(release, client, releaseArgs);
                      injected = true;
                      throw new Error("client release failed");
                    },
                  });
                }
                return value;
              });
            },
          });
        }
      };
      try {
        const booksId = await getDatabaseIdByModule("books");
        const item = await inTenantZero(() =>
          chokePoint.createItem({ databaseId: booksId, properties: { name: "Book" } }),
        );
        await withTransaction(pool, (client) => ensureItemAutomation(client, item.id));
        const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
        pool.on("acquire", onAcquire);
        const work = inTenantZero(() =>
          handleProcessLibraryMetadataTask(
            pool,
            { itemId: item.id, databaseId: booksId, config: { source: "openLibrary", coverKey: "cover" } },
            async () => ({ status: "found", cover: { mimeType: "image/jpeg", bytes } }),
            undefined,
            storage,
          ),
        );
        if (failurePoint === "release") await expect(work).resolves.toBeUndefined();
        else await expect(work).rejects.toThrow("Library metadata processing failed");
        expect(injected).toBe(true);
        pool.off("acquire", onAcquire);
        for (const [client, original] of originals) {
          for (const key of ["query", "release"] as const) {
            const descriptor = original[key];
            if (descriptor) Object.defineProperty(client, key, descriptor);
            else Reflect.deleteProperty(client, key);
          }
        }
        originals.clear();
        const updated = await chokePoint.getItem(booksId, item.id);
        const reference = z.object({ blobId: z.uuid() }).parse(updated?.properties.cover);
        const row = await pool.query<{ storage_key: string }>("SELECT storage_key FROM blobs WHERE id = $1", [
          reference.blobId,
        ]);
        expect(row.rows).toHaveLength(1);
        expect(await readFile(join(root, row.rows[0]!.storage_key))).toEqual(bytes);
      } catch (error) {
        failures.push(error);
      }
      pool.off("acquire", onAcquire);
      for (const [client, original] of originals) {
        for (const key of ["query", "release"] as const) {
          const descriptor = original[key];
          if (descriptor) Object.defineProperty(client, key, descriptor);
          else Reflect.deleteProperty(client, key);
        }
      }
      try {
        await rm(root, { recursive: true, force: true });
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Cover acknowledgement test and cleanup failed");
    },
  );

  it("records found and not-found outcomes and invalidates status-only changes", async () => {
    const databaseId = await getDatabaseIdByModule("books");
    const found = await inTenantZero(() => chokePoint.createItem({ databaseId, properties: { name: "Found" } }));
    const missing = await inTenantZero(() => chokePoint.createItem({ databaseId, properties: { name: "Missing" } }));
    for (const item of [found, missing]) await withTransaction(pool, (client) => ensureItemAutomation(client, item.id));
    const events: InvalidationEvent[] = [];
    setInvalidationHook((event) => events.push(event));
    try {
      const config = { source: "openLibrary", coverKey: "cover" };
      await inTenantZero(() =>
        handleProcessLibraryMetadataTask(pool, { itemId: found.id, databaseId, config }, async () => ({
          status: "found",
          source: "openLibrary",
        })),
      );
      await inTenantZero(() =>
        handleProcessLibraryMetadataTask(pool, { itemId: missing.id, databaseId, config }, async () => ({
          status: "notFound",
          source: "openLibrary",
        })),
      );
      expect(await withTransaction(pool, (client) => getItemAutomation(client, found.id))).toMatchObject({
        status: "done",
        source: "openLibrary",
      });
      expect(await withTransaction(pool, (client) => getItemAutomation(client, missing.id))).toMatchObject({
        status: "notFound",
        source: "openLibrary",
      });
      expect(events.filter((event) => event.scope === "item").map((event) => event.itemId)).toEqual([
        found.id,
        missing.id,
      ]);
    } finally {
      setInvalidationHook(() => {});
    }
  });

  it("keeps found status when a removed cover is not returned on a later run", async () => {
    const root = await mkdtemp(join(tmpdir(), "semprec-library-removed-cover-"));
    const failures: unknown[] = [];
    try {
      const storage = new LocalFsBlobStorageWriter(root);
      const databaseId = await getDatabaseIdByModule("books");
      const item = await inTenantZero(() => chokePoint.createItem({ databaseId, properties: { name: "Book" } }));
      await withTransaction(pool, (client) => ensureItemAutomation(client, item.id));
      const payload = { itemId: item.id, databaseId, config: { source: "openLibrary", coverKey: "cover" } };
      await inTenantZero(() =>
        handleProcessLibraryMetadataTask(
          pool,
          payload,
          async () => ({
            status: "found",
            source: "openLibrary",
            cover: { mimeType: "image/jpeg", bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]) },
          }),
          undefined,
          storage,
        ),
      );
      expect((await chokePoint.getItem(databaseId, item.id))?.properties.cover).toBeDefined();
      await inTenantZero(() =>
        withTransaction(pool, (client) =>
          updateItemWithClient(
            client,
            { databaseId, itemId: item.id, propertiesPatch: { cover: null } },
            { allowedSystemKeys: ["cover"] },
          ),
        ),
      );
      await inTenantZero(() =>
        handleProcessLibraryMetadataTask(
          pool,
          payload,
          async () => ({ status: "found", source: "openLibrary" }),
          undefined,
          storage,
        ),
      );
      expect((await withTransaction(pool, (client) => getItemAutomation(client, item.id)))?.status).toBe("done");
      expect((await chokePoint.getItem(databaseId, item.id))?.properties.cover).toBeNull();
    } catch (error) {
      failures.push(error);
    }
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Removed cover test and cleanup failed");
  });

  it("records a safe provider outcome and increments its attempt", async () => {
    const databaseId = await getDatabaseIdByModule("books");
    const item = await inTenantZero(() => chokePoint.createItem({ databaseId, properties: { name: "Book" } }));
    await withTransaction(pool, (client) => ensureItemAutomation(client, item.id));
    await expect(
      inTenantZero(() =>
        handleProcessLibraryMetadataTask(
          pool,
          { itemId: item.id, databaseId, config: { source: "openLibrary", coverKey: "cover" } },
          createLibraryMetadataFetcher({
            fetch: async () => new Response("private-provider-response-secret", { status: 503 }),
          }),
        ),
      ),
    ).rejects.toThrow("Library metadata processing failed");
    expect(await withTransaction(pool, (client) => getItemAutomation(client, item.id))).toMatchObject({
      status: "error",
      errorCode: "sourceUnavailable",
      source: "googleBooks",
      attempts: 1,
    });
  });

  it("keeps a queued 503 response private in its automation row and actual worker log", async () => {
    const databaseId = await getDatabaseIdByModule("books");
    const item = await inTenantZero(() => chokePoint.createItem({ databaseId, properties: { name: "Book" } }));
    const responseSecret = "private-503-response-secret";
    const fetcher = vi.fn(async (_url: string) => new Response(responseSecret, { status: 503 }));
    const errorLog = vi.spyOn(console, "error");
    let captured: string;
    try {
      await drainQueue(libraryRegistry(), createLibraryMetadataFetcher({ fetch: fetcher }));
      captured = inspect(errorLog.mock.calls, { depth: 8 });
    } finally {
      errorLog.mockRestore();
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(captured).toContain("Library metadata processing failed");
    expect(captured).not.toContain(responseSecret);
    for (const [url] of fetcher.mock.calls) expect(captured).not.toContain(url);
    const automation = await withTransaction(pool, (client) => getItemAutomation(client, item.id));
    expect(automation).toMatchObject({
      status: "error",
      errorCode: "sourceUnavailable",
      source: "googleBooks",
      attempts: 1,
      error: "Library metadata processing failed",
    });
    expect(JSON.stringify(automation)).not.toContain(responseSecret);
    for (const [url] of fetcher.mock.calls) expect(JSON.stringify(automation)).not.toContain(url);
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
    const errorLog = vi.spyOn(console, "error");
    try {
      await drainQueue(registry, failingFetcher);
      const captured = inspect(errorLog.mock.calls, { depth: 8 });
      expect(captured).toContain("Library metadata processing failed");
      expect(captured).not.toContain("private-provider-secret");
      expect(captured).not.toContain("https://secret.invalid");
    } finally {
      errorLog.mockRestore();
    }

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
    const payload = { itemId: item.id, databaseId: moviesId, config: { source: "tmdb", coverKey: "cover" } };
    await inTenantZero(() => withTransaction(pool, (client) => enqueueLibraryMetadataProcessing(client, payload)));
    expect(
      await inTenantZero(() => withTransaction(pool, (client) => getItemAutomation(client, item.id))),
    ).toMatchObject({
      status: "pending",
    });

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
    const payload = { itemId: item.id, databaseId: moviesId, config: { source: "tmdb", coverKey: "cover" } };

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

  it("retries a not-found title through the actual daily heartbeat", async () => {
    const booksId = await getDatabaseIdByModule("books");
    const registry = libraryRegistry();
    const item = await inTenantZero(() =>
      chokePoint.createItem({ databaseId: booksId, properties: { name: "Missing" } }),
    );
    await drainQueue(registry, async () => ({ status: "notFound", source: "openLibrary" }));
    expect(await withTransaction(pool, (client) => getItemAutomation(client, item.id))).toMatchObject({
      status: "notFound",
      source: "openLibrary",
    });
    const heartbeat = await pool.query<{ id: string }>(
      "SELECT id FROM project_heartbeats WHERE action_id = $1 AND action_config->>'databaseId' = $2",
      [LIBRARY_METADATA_RETRY_SWEEP_ACTION_ID, booksId],
    );
    expect(heartbeat.rows).toHaveLength(1);
    const updated = await pool.query(
      "UPDATE project_heartbeats SET next_fire_at = now() - interval '1 minute' WHERE id = $1",
      [heartbeat.rows[0]!.id],
    );
    expect(updated.rowCount).toBe(1);
    await inTenantZero(() => withTransaction(pool, (client) => sweepDueHeartbeats(client)));
    const retried: string[] = [];
    const found: LibraryMetadataFetcher = async (row) => {
      retried.push(row.id);
      return { status: "found", source: "openLibrary" };
    };
    await drainQueue(registry, found);
    await drainQueue(registry, found);
    expect(retried).toContain(item.id);
    expect((await withTransaction(pool, (client) => getItemAutomation(client, item.id)))?.status).toBe("done");
  });

  it("selects error and notFound for retry but leaves done and locked alone", async () => {
    const booksId = await getDatabaseIdByModule("books");
    const items = await inTenantZero(() =>
      Promise.all(
        ["Error", "Missing", "Found", "Locked"].map((name) =>
          chokePoint.createItem({ databaseId: booksId, properties: { name } }),
        ),
      ),
    );
    await inTenantZero(() =>
      withTransaction(pool, async (client) => {
        for (const item of items) await ensureItemAutomation(client, item.id);
        await markItemAutomationError(client, items[0]!.id, "sourceUnavailable", "sourceUnavailable", "openLibrary");
        await markItemAutomationNotFound(client, items[1]!.id, "openLibrary");
        await markItemAutomationDone(client, items[2]!.id, "openLibrary");
        await setItemAutomationLocked(client, items[3]!.id, true);
      }),
    );
    const action = createLibraryMetadataRetrySweepAction(pool);
    await inTenantZero(() =>
      action(
        { databaseId: booksId, source: "openLibrary", coverKey: "cover" },
        { heartbeatId: "heartbeat", projectItemId: "project" },
      ),
    );
    const rows = await pool.query<{ key: string }>(
      "SELECT key FROM graphile_worker.jobs WHERE key = ANY($1::text[]) ORDER BY key",
      [items.map((item) => `library-metadata:${item.id}`)],
    );
    expect(rows.rows.map((row) => row.key)).toEqual(
      [`library-metadata:${items[0]!.id}`, `library-metadata:${items[1]!.id}`].sort(),
    );
    expect((await withTransaction(pool, (client) => getItemAutomation(client, items[2]!.id)))?.status).toBe("done");
    expect((await withTransaction(pool, (client) => getItemAutomation(client, items[3]!.id)))?.status).toBe("locked");
  });

  it("does not enqueue repeated unsupported sweeps and resumes after configuration repair", async () => {
    const booksId = await getDatabaseIdByModule("books");
    const registry = libraryRegistry();
    const item = await inTenantZero(() => chokePoint.createItem({ databaseId: booksId, properties: { name: "Dune" } }));
    await drainQueue(registry, async () => {
      throw new Error("provider unavailable");
    });
    const before = await withTransaction(pool, (client) => getItemAutomation(client, item.id));
    expect(before?.status).toBe("error");
    const countJobs = async () => {
      const result = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM graphile_worker.jobs WHERE key = $1",
        [`library-metadata:${item.id}`],
      );
      return result.rows[0]?.count;
    };
    const existingJobs = await countJobs();
    expect(existingJobs).toBe("1");
    const readJob = () =>
      pool.query<Record<string, unknown>>("SELECT id, attempts, run_at FROM graphile_worker.jobs WHERE key = $1", [
        `library-metadata:${item.id}`,
      ]);
    const existing = (await readJob()).rows;
    const action = createLibraryMetadataRetrySweepAction(pool);
    const context = { heartbeatId: "heartbeat", projectItemId: "project" };
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        inTenantZero(() => action({ databaseId: booksId, source: "invalid", coverKey: "cover" }, context)),
      ).rejects.toThrow("Unsupported library metadata source configuration");
      expect(await countJobs()).toBe(existingJobs);
      expect((await readJob()).rows).toEqual(existing);
      expect(await withTransaction(pool, (client) => getItemAutomation(client, item.id))).toEqual(before);
    }
    await inTenantZero(() => action({ databaseId: booksId, source: "openLibrary", coverKey: "cover" }, context));
    expect(await countJobs()).toBe("1");
    await drainQueue(registry, async () => ({ status: "notFound", source: "openLibrary" }));
    expect((await withTransaction(pool, (client) => getItemAutomation(client, item.id)))?.status).toBe("notFound");
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
    await runInTenant(tenantB, () =>
      withTransaction(runtimePool, (client) =>
        enqueueLibraryMetadataProcessing(client, {
          itemId,
          databaseId: moviesId,
          config: { source: "tmdb", coverKey: "cover" },
        }),
      ),
    );
    expect(
      await runInTenant(tenantB, () => withTransaction(runtimePool, (client) => getItemAutomation(client, itemId))),
    ).toMatchObject({ status: "pending" });

    await expect(
      runInTenant(tenantB, () =>
        handleProcessLibraryMetadataTask(
          runtimePool,
          { itemId, databaseId: moviesId, config: { source: "tmdb", coverKey: "cover" } },
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
