import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, enqueueJob, runOnce, runWorker } from "@alldots/queue";
import { runInTenant } from "@alldots/shared";
import { createLibraryMetadataFetcher } from "../library/libraryMetadataFetcher.js";
import { LibraryMetadataConfigurationError } from "../library/libraryMetadataConfig.js";
import { downloadLibraryCover } from "../library/openLibraryFetcher.js";
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
import { prepareUserItemPatch, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { getDatabase } from "../chokePoint/databasesStore.js";
import { purgeExpiredTrash } from "../trash/purgeExpiredTrash.js";
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

/** The bytes every cover fixture serves and stores. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const OPEN_LIBRARY = { source: "openLibrary", coverKey: "cover" };

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

/** Creates an item in the module's database and, unless told otherwise, its automation row. */
async function newItem(moduleId: string, properties: Record<string, unknown> = {}, automation = true) {
  const databaseId = await getDatabaseIdByModule(moduleId);
  const item = await inTenantZero(() =>
    chokePoint.createItem({ databaseId, properties: { name: "Book", ...properties } }),
  );
  if (automation) await withTransaction(pool, (client) => ensureItemAutomation(client, item.id));
  return { databaseId, itemId: item.id };
}

const automationOf = (itemId: string) => withTransaction(pool, (client) => getItemAutomation(client, itemId));
const propertiesOf = async (databaseId: string, itemId: string) =>
  (await chokePoint.getItem(databaseId, itemId))?.properties;

function processMetadata(
  itemId: string,
  databaseId: string,
  config: Record<string, unknown>,
  fetcher: LibraryMetadataFetcher,
  storage?: BlobStorageWriter,
) {
  return inTenantZero(() =>
    handleProcessLibraryMetadataTask(
      pool,
      { itemId, databaseId, config: { ...OPEN_LIBRARY, ...config } },
      fetcher,
      undefined,
      storage,
    ),
  );
}

const failingFetcher =
  (message: string): LibraryMetadataFetcher =>
  async () => {
    throw new Error(message);
  };

/** Reads the stored bytes of the item's system cover. */
async function storedCover(root: string, databaseId: string, itemId: string): Promise<Buffer> {
  const reference = z.object({ blobId: z.uuid() }).parse((await propertiesOf(databaseId, itemId))?.cover);
  const { rows } = await pool.query<{ storage_key: string }>("SELECT storage_key FROM blobs WHERE id = $1", [
    reference.blobId,
  ]);
  expect(rows).toHaveLength(1);
  return readFile(join(root, rows[0]!.storage_key));
}

/**
 * Runs the case with fresh storage roots and always removes them and disarms the cover transport; a
 * cleanup failure never hides the case's own failure.
 */
async function withRoots(count: number, run: (roots: string[]) => Promise<void>): Promise<void> {
  const roots: string[] = [];
  const failures: unknown[] = [];
  try {
    for (let i = 0; i < count; i++) roots.push(await mkdtemp(join(tmpdir(), "alldots-library-")));
    await run(roots);
  } catch (error) {
    failures.push(error);
  }
  coverTransport.active = false;
  coverTransport.urls.length = 0;
  for (const root of roots) {
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Library test and cleanup failed");
}

function armCoverTransport(): void {
  coverTransport.urls.length = 0;
  coverTransport.active = true;
}

/** A Google Books answer after an empty Open Library search. */
const googleFallback = (items: unknown[]) =>
  createLibraryMetadataFetcher({
    fetch: async (url) =>
      new Response(
        JSON.stringify(
          url.startsWith("https://openlibrary.org/")
            ? { docs: [] }
            : { kind: "books#volumes", totalItems: items.length, items },
        ),
      ),
  });

/** Makes the database's daily retry heartbeat due and sweeps it. */
async function fireRetryHeartbeat(databaseId: string): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM project_heartbeats WHERE action_id = $1 AND action_config ->> 'databaseId' = $2",
    [LIBRARY_METADATA_RETRY_SWEEP_ACTION_ID, databaseId],
  );
  expect(rows).toHaveLength(1);
  await pool.query("UPDATE project_heartbeats SET next_fire_at = now() - interval '1 minute' WHERE id = $1", [
    rows[0]!.id,
  ]);
  await inTenantZero(() => withTransaction(pool, (client) => sweepDueHeartbeats(client)));
}

const jobCount = async (itemId: string) =>
  (
    await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM graphile_worker.jobs WHERE key = $1", [
      `library-metadata:${itemId}`,
    ])
  ).rows[0]?.count;

const notificationIds = async (itemId: string) =>
  (await pool.query<{ id: string }>("SELECT id FROM notifications WHERE source_id = $1", [itemId])).rows;

async function resetSeeded(): Promise<void> {
  pool ??= getTestPool();
  chokePoint ??= createChokePoint(pool);
  await resetDatabase(pool);
  await seedSystem(pool);
}

describe("library rating validation", () => {
  beforeEach(resetSeeded);

  const invalidRatings = [7, 2.5, -1, "4", NaN];

  describe.each(["books", "movies"])("%s", (moduleId) => {
    it("rejects an invalid rating on create and update, accepts 0 to 5 and null", async () => {
      const databaseId = await getDatabaseIdByModule(moduleId);
      for (const rating of invalidRatings) {
        await expect(
          inTenantZero(() => chokePoint.createItem({ databaseId, properties: { name: "X", rating } })),
        ).rejects.toMatchObject({ status: 400, details: { field: "rating" } });
      }
      const { itemId } = await newItem(moduleId, { rating: 0 }, false);
      for (const rating of invalidRatings) {
        const error = await chokePoint
          .updateItem({ databaseId, itemId, propertiesPatch: { rating } })
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toMatchObject({ details: { field: "rating" } });
      }
      for (const rating of [0, 1, 5, null]) {
        await chokePoint.updateItem({ databaseId, itemId, propertiesPatch: { rating } });
      }
      const created = await newItem(moduleId, { rating: 5 }, false);
      expect((await propertiesOf(databaseId, created.itemId))?.rating).toBe(5);
    });

    it("validates only the keys present in a patch", async () => {
      const { databaseId, itemId } = await newItem(moduleId, {}, false);
      // Seed a stored invalid value behind the hooks; an unrelated patch must still succeed.
      await pool.query(`UPDATE items SET properties = jsonb_set(properties, '{rating}', '9'::jsonb) WHERE id = $1`, [
        itemId,
      ]);
      await chokePoint.updateItem({ databaseId, itemId, propertiesPatch: { name: "Renamed" } });
    });
  });

  it("validates watchedWith edge metadata.rating from 1 to 5 and leaves other edges valid", async () => {
    const movie = await newItem("movies", { name: "M" }, false);
    const person = await newItem("people", { name: "Alex" }, false);
    const watchedWith = (await chokePoint.listProperties(movie.databaseId)).find((p) => p.key === "watchedWith")!;
    const edge = (metadata?: Record<string, unknown>) =>
      chokePoint.createRelation({
        relationPropertyId: watchedWith.id,
        callerItemId: movie.itemId,
        targetItemId: person.itemId,
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
    expect((await propertiesOf(database.id, item.id))?.rating).toBe(2.5);
  });

  it("rejects an unknown stored automation error code while accepting a known code and legacy null", async () => {
    const { itemId } = await newItem("books", {}, false);
    await inTenantZero(() => withTransaction(pool, (client) => ensureItemAutomation(client, itemId)));
    const read = () => inTenantZero(() => automationOf(itemId));
    expect((await read())?.errorCode).toBeNull();
    await pool.query("UPDATE item_automation SET error_code = 'deleted' WHERE item_id = $1", [itemId]);
    expect((await read())?.errorCode).toBe("deleted");
    await pool.query("UPDATE item_automation SET error_code = 'unexpected' WHERE item_id = $1", [itemId]);
    await expect(read()).rejects.toThrow("Unknown item automation error code");
  });
});

describe("library module", () => {
  beforeEach(resetSeeded);

  afterAll(async () => {
    await pool?.end();
  });

  it("seeds Books and Movies/TV as concrete instantiations of the generic contract", async () => {
    const booksId = await getDatabaseIdByModule("books");
    const moviesId = await getDatabaseIdByModule("movies");
    const books = await chokePoint.listProperties(booksId);
    const movies = await chokePoint.listProperties(moviesId);
    const coverKeys = ["cover", "coverOverride", "coverRemoved", "coverSource"];

    expect(books.map((p) => p.key).sort()).toEqual(
      [...coverKeys, "author", "isbn", "name", "rating", "status", "year"].sort(),
    );
    expect(movies.map((p) => p.key).sort()).toEqual(
      [
        ...coverKeys,
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
    for (const properties of [books, movies]) {
      expect(properties.find((p) => p.key === "coverOverride")).toMatchObject({ type: "image", owner: "user" });
      expect(properties.find((p) => p.key === "coverRemoved")).toMatchObject({ type: "checkbox", owner: "user" });
      expect(properties.find((p) => p.key === "coverSource")).toMatchObject({
        type: "select",
        owner: "user",
        config: { options: [{ key: "candidate" }, { key: "userPhoto" }, { key: "userImage" }] },
      });
    }
    expect(movies.find((p) => p.key === "year")).toMatchObject({ type: "number", owner: "user" });
    expect(movies.find((p) => p.key === "secondaryRating")).toMatchObject({ type: "number", owner: "system" });
    expect(movies.find((p) => p.key === "sourceUrl")).toMatchObject({ type: "url", owner: "system" });

    const coverConfig = {
      coverKey: "cover",
      coverOverrideKey: "coverOverride",
      coverRemovedKey: "coverRemoved",
      coverSourceKey: "coverSource",
      statusKey: "status",
    };
    const booksViews = await chokePoint.listViewsByDatabase(booksId);
    expect(booksViews).toHaveLength(1);
    expect(booksViews[0]!.type).toBe("library-grid");
    expect(booksViews[0]!.config).toMatchObject({ ...coverConfig, subtitleKey: "author" });
    expect(booksViews[0]!.config).not.toHaveProperty("secondaryRatingLabel");

    const moviesViews = await chokePoint.listViewsByDatabase(moviesId);
    expect(moviesViews[0]!.config).toMatchObject({
      ...coverConfig,
      subtitleKey: "year",
      ratingKey: "rating",
      secondaryRatingKey: "secondaryRating",
      secondaryRatingLabel: "property.movies.secondaryRating.name",
      sourceUrlKey: "sourceUrl",
      coverGlyph: "🎬",
    });
  });

  it("fills empty declared fields without overwriting user input or locked items", async () => {
    const config = { authorKey: "author", yearKey: "year", isbnKey: "isbn" };
    const empty = await newItem("books", { name: "Empty" });
    const entered = await newItem("books", { name: "Entered", author: "User" });
    const locked = await newItem("books", { name: "Locked" });
    const lockedBefore = await propertiesOf(locked.databaseId, locked.itemId);
    await withTransaction(pool, (client) => setItemAutomationLocked(client, locked.itemId, true));
    for (const { databaseId, itemId } of [empty, entered, locked]) {
      await processMetadata(itemId, databaseId, config, async () => ({ author: "Fetched", year: 2020 }));
    }
    expect(await propertiesOf(empty.databaseId, empty.itemId)).toMatchObject({ author: "Fetched", year: 2020 });
    expect(await propertiesOf(entered.databaseId, entered.itemId)).toMatchObject({ author: "User", year: 2020 });
    expect(await propertiesOf(locked.databaseId, locked.itemId)).toEqual(lockedBefore);
  });

  it("preserves an author entered while the metadata fetch is in flight", async () => {
    const { databaseId, itemId } = await newItem("books");
    await processMetadata(itemId, databaseId, { authorKey: "author" }, async () => {
      await chokePoint.updateItem({ databaseId, itemId, propertiesPatch: { author: "User" } });
      return { author: "Fetched" };
    });
    expect((await propertiesOf(databaseId, itemId))?.author).toBe("User");
  });

  it("does not apply a result when automation is locked during the fetch", async () => {
    const { databaseId, itemId } = await newItem("books");
    const before = await propertiesOf(databaseId, itemId);
    await processMetadata(itemId, databaseId, { authorKey: "author" }, async () => {
      await withTransaction(pool, (client) => setItemAutomationLocked(client, itemId, true));
      return { author: "Fetched" };
    });
    expect(await propertiesOf(databaseId, itemId)).toEqual(before);
    expect((await automationOf(itemId))?.status).toBe("locked");
  });

  it("skips an invalid movie type and keeps a user's year and type while applying other metadata", async () => {
    const config = { source: "tmdb", typeKey: "type", yearKey: "year", secondaryRatingKey: "secondaryRating" };
    const fresh = await newItem("movies", { name: "Film" });
    await processMetadata(fresh.itemId, fresh.databaseId, config, async () => ({ type: "invalid", year: 2021 }));
    const result = await propertiesOf(fresh.databaseId, fresh.itemId);
    expect(result?.year).toBe(2021);
    expect(result?.type).toBeUndefined();

    const entered = await newItem("movies", { name: "Film", year: 1999, type: "series" });
    await processMetadata(entered.itemId, entered.databaseId, config, async () => ({
      status: "found",
      source: "tmdb",
      type: "movie",
      year: 2024,
      secondaryRating: 79,
    }));
    expect(await propertiesOf(entered.databaseId, entered.itemId)).toMatchObject({
      year: 1999,
      type: "series",
      secondaryRating: 79,
    });
  });

  it("rejects unsupported source before fetching, creating automation or enqueueing", async () => {
    const { databaseId, itemId } = await newItem("books", {}, false);
    const item = await chokePoint.getItem(databaseId, itemId);
    if (!item) throw new Error("Missing book fixture");
    const config = { databaseId, source: "unsupported-private-value", coverKey: "cover" };
    const context = { heartbeatId: "heartbeat", projectItemId: "project", itemId };
    const error = "Unsupported library metadata source configuration";
    const fetcher = createLibraryMetadataFetcher({
      fetch: async () => {
        throw new Error("Unexpected fetch");
      },
    });
    await expect(fetcher(item, config)).rejects.toThrow(error);
    await expect(
      inTenantZero(() =>
        withTransaction(pool, (client) => enqueueLibraryMetadataProcessing(client, { itemId, databaseId, config })),
      ),
    ).rejects.toThrow(error);
    await expect(createLibraryMetadataTriggerAction(pool)(config, context)).rejects.toThrow(error);
    await expect(createLibraryMetadataRetrySweepAction(pool)(config, context)).rejects.toThrow(error);
    expect(await automationOf(itemId)).toBeNull();
    expect(await jobCount(itemId)).toBe("0");
  });

  it.each([
    {
      name: "rejects a legacy invalid queued job",
      config: { source: "bad" },
      failure: () => undefined,
      refusal: "Unsupported library metadata source configuration",
    },
    {
      name: "preserves a recognized downstream configuration refusal",
      config: {},
      failure: () => new LibraryMetadataConfigurationError(),
      refusal: undefined,
    },
  ])("$name without altering its existing automation", async ({ config, failure, refusal }) => {
    const { databaseId, itemId } = await newItem("books");
    const before = await automationOf(itemId);
    const thrown = failure();
    let invoked = false;
    const work = processMetadata(itemId, databaseId, config, async () => {
      invoked = true;
      if (thrown) throw thrown;
      return {};
    });
    if (thrown) await expect(work).rejects.toBe(thrown);
    else await expect(work).rejects.toThrow(refusal);
    expect(invoked).toBe(Boolean(thrown));
    expect(await automationOf(itemId)).toEqual(before);
  });

  it("bounds a queued legacy unsupported source to its existing three attempts", async () => {
    const { databaseId, itemId } = await newItem("books", {}, false);
    await inTenantZero(() =>
      withTransaction(pool, async (client) => {
        await ensureItemAutomation(client, itemId);
        await enqueueJob(
          client,
          CORE_TASK_NAMES.LIBRARY_METADATA_PROCESS,
          { itemId, databaseId, config: { source: "legacy-invalid", coverKey: "cover" } },
          { jobKey: `library-metadata:${itemId}`, maxAttempts: 3 },
        );
      }),
    );
    const before = await automationOf(itemId);
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
      await vi.waitFor(
        async () => {
          const jobs = await pool.query<{ attempts: number; max_attempts: number; locked_at: Date | null }>(
            "SELECT attempts, max_attempts, locked_at FROM graphile_worker.jobs WHERE key = $1",
            [`library-metadata:${itemId}`],
          );
          expect(jobs.rows).toEqual([{ attempts: 3, max_attempts: 3, locked_at: null }]);
        },
        { timeout: 30_000, interval: 100 },
      );
      expect(await automationOf(itemId)).toEqual(before);
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
    expect(registry.get(LIBRARY_GRID_VIEW_TYPE)).toBeUndefined();

    // Registration is the runtime boundary for persisted view configs.
    registerLibraryGridViewType(registry);
    const schema = registry.get(LIBRARY_GRID_VIEW_TYPE)?.configSchema;
    const base = { coverKey: "cover", subtitleKey: "year", ratingKey: "rating", statusKey: "status" };
    expect(
      schema?.safeParse({
        ...base,
        secondaryRatingKey: "secondaryRating",
        secondaryRatingLabel: "property.movies.secondaryRating.name",
        sourceUrlKey: "sourceUrl",
        coverGlyph: "🎬",
      }).success,
    ).toBe(true);
    expect(schema?.safeParse({ coverKey: "cover", subtitleKey: "year", ratingKey: "rating" }).success).toBe(false);
    expect(
      schema?.safeParse({
        ...base,
        coverOverrideKey: "coverOverride",
        coverRemovedKey: "coverRemoved",
        coverSourceKey: "coverSource",
      }).success,
    ).toBe(true);
    for (const key of ["coverOverrideKey", "coverRemovedKey", "coverSourceKey", "statusKey"]) {
      expect(schema?.safeParse({ ...base, [key]: 1 }).success, key).toBe(false);
    }
  });

  it("rejects writing owner:'system' library fields through the generic create/update path", async () => {
    const booksId = await getDatabaseIdByModule("books");
    await expect(
      inTenantZero(() =>
        chokePoint.createItem({ databaseId: booksId, properties: { name: "Dune", cover: { blobId: "x" } } }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const { itemId } = await newItem("books", { name: "Dune" }, false);
    await expect(
      chokePoint.updateItem({ databaseId: booksId, itemId, propertiesPatch: { cover: { blobId: "x" } } }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("creating a library item drives metadata and stores actual cover bytes", async () => {
    await withRoots(1, async ([root]) => {
      const storage = new LocalFsBlobStorageWriter(root!);
      const { databaseId, itemId } = await newItem("books", { name: "Dune", author: "Frank Herbert" }, false);
      const fetcher: LibraryMetadataFetcher = async () => ({ cover: { mimeType: "image/jpeg", bytes: JPEG } });
      await runOnce({
        pgPool: pool,
        taskList: createCoreTaskList(
          pool,
          libraryRegistry(),
          fetcher,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          storage,
        ),
      });
      expect(await storedCover(root!, databaseId, itemId)).toEqual(JPEG);
      expect((await automationOf(itemId))?.status).toBe("done");
    });
  });

  it("downloads a Google fallback cover with a query without exposing that URL", async () => {
    await withRoots(1, async ([root]) => {
      const { databaseId, itemId } = await newItem("books");
      const coverUrl = "https://google-cover.invalid/image?id=fixture-secret";
      const fetcher = googleFallback([
        { volumeInfo: { title: "Book", imageLinks: { thumbnail: coverUrl } } },
        { volumeInfo: { title: "Other", imageLinks: { thumbnail: coverUrl } } },
      ]);
      armCoverTransport();
      const stored = await chokePoint.getItem(databaseId, itemId);
      if (!stored) throw new Error("Missing book fixture");
      const result = await fetcher(stored, OPEN_LIBRARY);
      expect(result).toMatchObject({ status: "found", source: "googleBooks", cover: { bytes: JPEG } });
      expect(JSON.stringify(result)).not.toContain("fixture-secret");
      await processMetadata(itemId, databaseId, {}, fetcher, new LocalFsBlobStorageWriter(root!));
      expect(coverTransport.urls).toEqual([coverUrl, coverUrl]);
      expect(await storedCover(root!, databaseId, itemId)).toEqual(JPEG);
    });
  });

  it("applies book and movie provider fixtures through the job and real cover owner", async () => {
    await withRoots(1, async ([root]) => {
      const storage = new LocalFsBlobStorageWriter(root!);
      const book = await newItem("books", { name: "Hovory k sobě" });
      const movie = await newItem("movies", { name: "Duna: Část druhá" });
      const fetcher = createLibraryMetadataFetcher({
        tmdbToken: "fixture-token",
        fetch: async (url) => {
          if (url.startsWith("https://openlibrary.org/"))
            return Response.json({
              docs: [
                {
                  title: "Hovory k sobě",
                  author_name: ["Marcus Aurelius"],
                  first_publish_year: 180,
                  isbn: ["9780000000000"],
                  cover_i: 123,
                },
              ],
            });
          if (url.includes("/search/multi"))
            return Response.json({
              results: [
                {
                  id: 1,
                  media_type: "movie",
                  title: "Duna: Část druhá",
                  release_date: "2024-02-28",
                  poster_path: "/fixture.jpg",
                },
              ],
            });
          if (url.endsWith("/movie/1")) return Response.json({ vote_average: 7.9, vote_count: 30 });
          throw new Error("Unexpected provider fixture URL");
        },
      });
      armCoverTransport();
      await processMetadata(
        book.itemId,
        book.databaseId,
        { authorKey: "author", yearKey: "year", isbnKey: "isbn" },
        fetcher,
        storage,
      );
      await processMetadata(
        movie.itemId,
        movie.databaseId,
        {
          source: "tmdb",
          yearKey: "year",
          typeKey: "type",
          secondaryRatingKey: "secondaryRating",
          sourceUrlKey: "sourceUrl",
        },
        fetcher,
        storage,
      );
      expect(coverTransport.urls).toEqual([
        "https://covers.openlibrary.org/b/id/123-L.jpg",
        "https://image.tmdb.org/t/p/w500/fixture.jpg",
      ]);
      expect(await propertiesOf(book.databaseId, book.itemId)).toMatchObject({
        author: "Marcus Aurelius",
        year: 180,
        isbn: "9780000000000",
      });
      expect(await propertiesOf(movie.databaseId, movie.itemId)).toMatchObject({
        year: 2024,
        type: "movie",
        secondaryRating: 79,
        sourceUrl: "https://www.themoviedb.org/movie/1",
      });
      for (const { databaseId, itemId } of [book, movie])
        expect(await storedCover(root!, databaseId, itemId)).toEqual(JPEG);
    });
  });

  it.each(["169.254.169.254", "10.0.0.1"])("refuses a cover hostname resolving to %s", async (address) => {
    const dns = stubDnsLookup({ "private-cover.invalid": [address], "image.tmdb.org": [address] });
    const blobCount = async () =>
      (await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM blobs")).rows;
    try {
      expect(await downloadLibraryCover("https://private-cover.invalid/cover.jpg")).toBeUndefined();
      expect(dns.calls).toContain("private-cover.invalid");
      const book = await newItem("books");
      const before = await blobCount();
      await processMetadata(
        book.itemId,
        book.databaseId,
        { authorKey: "author" },
        googleFallback([
          {
            volumeInfo: {
              title: "Book",
              authors: ["Fixture Author"],
              imageLinks: { thumbnail: "https://private-cover.invalid/cover.jpg" },
            },
          },
        ]),
      );
      const result = await propertiesOf(book.databaseId, book.itemId);
      expect(result?.author).toBe("Fixture Author");
      expect(result?.cover).toBeUndefined();
      expect(dns.calls.filter((host) => host === "private-cover.invalid")).toHaveLength(2);
      expect(await blobCount()).toEqual(before);

      const movie = await newItem("movies", { name: "Film" });
      const movieFetcher = createLibraryMetadataFetcher({
        tmdbToken: "fixture-token",
        fetch: async (url) =>
          Response.json(
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
      });
      await processMetadata(
        movie.itemId,
        movie.databaseId,
        { source: "tmdb", yearKey: "year", typeKey: "type", secondaryRatingKey: "secondaryRating" },
        movieFetcher,
      );
      const movieResult = await propertiesOf(movie.databaseId, movie.itemId);
      expect(movieResult).toMatchObject({ year: 2024, type: "movie", secondaryRating: 79 });
      expect(movieResult?.cover).toBeUndefined();
      expect(dns.calls).toContain("image.tmdb.org");
      expect(await blobCount()).toEqual(before);
    } finally {
      dns.restore();
    }
  });

  it("keeps canonical deduplicated cover bytes and removes staged bytes on rollback", async () => {
    await withRoots(1, async ([root]) => {
      const local = new LocalFsBlobStorageWriter(root!);
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
      const one = await newItem("books", { name: "One" });
      const two = await newItem("books", { name: "Two" });
      const rollback = await newItem("books", { name: "Rollback" });
      const locked = await newItem("books", { name: "Locked during fetch" });
      const found: LibraryMetadataFetcher = async () => ({
        status: "found",
        source: "openLibrary",
        cover: { mimeType: "image/jpeg", bytes: JPEG },
      });
      for (const { databaseId, itemId } of [one, two]) await processMetadata(itemId, databaseId, {}, found, storage);
      const canonical = z.object({ blobId: z.uuid() }).parse((await propertiesOf(one.databaseId, one.itemId))?.cover);
      expect((await propertiesOf(two.databaseId, two.itemId))?.cover).toEqual(canonical);
      expect(written).toHaveLength(2);
      expect(removed).toEqual([written[1]]);
      expect(await readFile(join(root!, written[0]!))).toEqual(JPEG);

      await expect(
        processMetadata(
          rollback.itemId,
          rollback.databaseId,
          { coverKey: "missingProperty" },
          async () => ({ status: "found", cover: { mimeType: "image/jpeg", bytes: Buffer.from([1, 2, 3]) } }),
          storage,
        ),
      ).rejects.toThrow("Library metadata processing failed");
      expect(written).toHaveLength(3);
      expect(removed).toEqual([written[1], written[2]]);
      expect(await propertiesOf(rollback.databaseId, rollback.itemId)).not.toHaveProperty("missingProperty");

      await processMetadata(
        locked.itemId,
        locked.databaseId,
        {},
        async () => {
          await withTransaction(pool, (client) => setItemAutomationLocked(client, locked.itemId, true));
          return { status: "found", cover: { mimeType: "image/jpeg", bytes: JPEG } };
        },
        storage,
      );
      expect(written).toHaveLength(4);
      expect(removed).toEqual([written[1], written[2], written[3]]);
      expect((await propertiesOf(locked.databaseId, locked.itemId))?.cover).toBeUndefined();
      expect((await automationOf(locked.itemId))?.status).toBe("locked");
      expect(await readFile(join(root!, written[0]!))).toEqual(JPEG);
      const rows = await pool.query<{ storage_key: string }>(
        "SELECT storage_key FROM blobs WHERE storage_key = ANY($1::text[])",
        [written],
      );
      expect(rows.rows).toEqual([{ storage_key: written[0] }]);
    });
  });

  it("preserves deduplicated bytes owned by the other storage root", async () => {
    await withRoots(2, async ([filesRoot, mailRoot]) => {
      const files = new LocalFsBlobStorageWriter(filesRoot!);
      const mail = new LocalFsBlobStorageWriter(mailRoot!);
      const removed: string[] = [];
      const storage: BlobStorageWriter = {
        writeStream: (...args) => files.writeStream(...args),
        async delete(key) {
          removed.push(key);
          await files.delete(key);
        },
        readStream: (key, range) => files.readStream(key, range),
      };
      const key = await inTenantZero(() => tenantBlobStorageKey(pool, "mail/fixture-cover.jpg"));
      const written = await mail.writeStream(key, Readable.from([JPEG]));
      const canonical = await inTenantZero(() =>
        withTransaction(pool, (client) => createBlob(client, { mimeType: "image/jpeg", storageKey: key, ...written })),
      );
      const { databaseId, itemId } = await newItem("books");
      await processMetadata(
        itemId,
        databaseId,
        {},
        async () => ({ status: "found", cover: { mimeType: "image/jpeg", bytes: JPEG } }),
        storage,
      );
      expect((await propertiesOf(databaseId, itemId))?.cover).toEqual({ blobId: canonical.id });
      expect(removed).toHaveLength(1);
      expect(removed[0]).not.toBe(key);
      expect(await readFile(join(mailRoot!, key))).toEqual(JPEG);
      const row = await pool.query<{ storage_key: string }>("SELECT storage_key FROM blobs WHERE id = $1", [
        canonical.id,
      ]);
      expect(row.rows).toEqual([{ storage_key: key }]);
    });
  });

  it.each(["release", "commit"] as const)(
    "retains committed cover bytes when the transaction %s acknowledgement fails",
    async (failurePoint) => {
      const originals = new Map<
        PoolClient,
        { query: PropertyDescriptor | undefined; release: PropertyDescriptor | undefined }
      >();
      let injected = false;
      const onAcquire = (client: PoolClient) => {
        if (originals.has(client)) return;
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const query = client.query;
        originals.set(client, {
          query: Object.getOwnPropertyDescriptor(client, "query"),
          release: Object.getOwnPropertyDescriptor(client, "release"),
        });
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
      };
      const restoreClients = () => {
        pool.off("acquire", onAcquire);
        for (const [client, original] of originals) {
          for (const key of ["query", "release"] as const) {
            const descriptor = original[key];
            if (descriptor) Object.defineProperty(client, key, descriptor);
            else Reflect.deleteProperty(client, key);
          }
        }
        originals.clear();
      };
      await withRoots(1, async ([root]) => {
        try {
          const { databaseId, itemId } = await newItem("books");
          pool.on("acquire", onAcquire);
          const work = processMetadata(
            itemId,
            databaseId,
            {},
            async () => ({ status: "found", cover: { mimeType: "image/jpeg", bytes: JPEG } }),
            new LocalFsBlobStorageWriter(root!),
          );
          if (failurePoint === "release") await expect(work).resolves.toBeUndefined();
          else await expect(work).rejects.toThrow("Library metadata processing failed");
          expect(injected).toBe(true);
          restoreClients();
          expect(await storedCover(root!, databaseId, itemId)).toEqual(JPEG);
        } finally {
          restoreClients();
        }
      });
    },
  );

  it("records found and not-found outcomes and invalidates status-only changes", async () => {
    const found = await newItem("books", { name: "Found" });
    const missing = await newItem("books", { name: "Missing" });
    const events: InvalidationEvent[] = [];
    setInvalidationHook((event) => events.push(event));
    try {
      for (const [{ databaseId, itemId }, status] of [
        [found, "found"],
        [missing, "notFound"],
      ] as const)
        await processMetadata(itemId, databaseId, {}, async () => ({ status, source: "openLibrary" }));
      expect(await automationOf(found.itemId)).toMatchObject({ status: "done", source: "openLibrary" });
      expect(await automationOf(missing.itemId)).toMatchObject({ status: "notFound", source: "openLibrary" });
      expect(events.filter((event) => event.scope === "item").map((event) => event.itemId)).toEqual([
        found.itemId,
        missing.itemId,
      ]);
    } finally {
      setInvalidationHook(() => {});
    }
  });

  it("keeps found status when a removed cover is not returned on a later run", async () => {
    await withRoots(1, async ([root]) => {
      const storage = new LocalFsBlobStorageWriter(root!);
      const { databaseId, itemId } = await newItem("books");
      await processMetadata(
        itemId,
        databaseId,
        {},
        async () => ({ status: "found", source: "openLibrary", cover: { mimeType: "image/jpeg", bytes: JPEG } }),
        storage,
      );
      expect((await propertiesOf(databaseId, itemId))?.cover).toBeDefined();
      await inTenantZero(() =>
        withTransaction(pool, (client) =>
          updateItemWithClient(
            client,
            { databaseId, itemId, propertiesPatch: { cover: null } },
            { allowedSystemKeys: ["cover"] },
          ),
        ),
      );
      await processMetadata(itemId, databaseId, {}, async () => ({ status: "found", source: "openLibrary" }), storage);
      expect((await automationOf(itemId))?.status).toBe("done");
      expect((await propertiesOf(databaseId, itemId))?.cover).toBeNull();
    });
  });

  /** Drains the queue and returns everything the worker logged as an error. */
  async function drainCapturingErrors(fetcher: LibraryMetadataFetcher): Promise<string> {
    const errorLog = vi.spyOn(console, "error");
    try {
      await drainQueue(libraryRegistry(), fetcher);
      return inspect(errorLog.mock.calls, { depth: 8 });
    } finally {
      errorLog.mockRestore();
    }
  }

  it("keeps a queued 503 response private in its automation row and actual worker log", async () => {
    const { itemId } = await newItem("books", {}, false);
    const responseSecret = "private-503-response-secret";
    const fetch = vi.fn(async (_url: string) => new Response(responseSecret, { status: 503 }));
    const captured = await drainCapturingErrors(createLibraryMetadataFetcher({ fetch }));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(captured).toContain("Library metadata processing failed");
    const automation = await automationOf(itemId);
    expect(automation).toMatchObject({
      status: "error",
      errorCode: "sourceUnavailable",
      source: "googleBooks",
      attempts: 1,
      error: "Library metadata processing failed",
    });
    for (const secret of [responseSecret, ...fetch.mock.calls.map(([url]) => url)]) {
      expect(captured).not.toContain(secret);
      expect(JSON.stringify(automation)).not.toContain(secret);
    }
  });

  it("a failed fetch records the error and increments attempts, leaving the row in 'error'", async () => {
    const { itemId } = await newItem("movies", { name: "Sicario", year: 2015 }, false);
    const captured = await drainCapturingErrors(failingFetcher("private-provider-secret https://secret.invalid"));
    expect(captured).toContain("Library metadata processing failed");
    expect(captured).not.toContain("private-provider-secret");
    expect(captured).not.toContain("https://secret.invalid");
    const automation = await automationOf(itemId);
    expect(automation).toMatchObject({ status: "error", error: "Library metadata processing failed", attempts: 1 });
    expect(JSON.stringify(automation)).not.toContain("private-provider-secret");
  });

  it("writes an automation_error notification on failure, deduped by job id but not across distinct failing jobs", async () => {
    const { databaseId, itemId } = await newItem("movies", { name: "Sicario", year: 2015 }, false);
    const user = await createUser(pool, {
      email: "owner@example.test",
      passwordHash: await hashPassword("s3cret-password"),
      locale: "en",
      tenantId: getTenantZeroId(),
    });
    const payload = { itemId, databaseId, config: { source: "tmdb", coverKey: "cover" } };
    await inTenantZero(() => withTransaction(pool, (client) => enqueueLibraryMetadataProcessing(client, payload)));
    expect(await inTenantZero(() => automationOf(itemId))).toMatchObject({ status: "pending" });
    const fail = (jobId: string) =>
      expect(
        handleProcessLibraryMetadataTask(pool, payload, failingFetcher("source unavailable"), { job: { id: jobId } }),
      ).rejects.toThrow("Library metadata processing failed");

    await fail("job-1");
    const { rows } = await pool.query(
      `SELECT user_id, kind, title, link_href, source_table, source_id, transition_instance FROM notifications WHERE source_id = $1`,
      [itemId],
    );
    expect(rows).toMatchObject([
      {
        user_id: user.id,
        kind: "automation_error",
        title: "Item automation failed",
        link_href: `?page=library-item&id=${itemId}`,
        source_table: "item_automation",
        transition_instance: "job-1",
      },
    ]);
    // Redelivery of the same job must not duplicate the notification.
    await fail("job-1");
    expect(await notificationIds(itemId)).toHaveLength(1);
    await fail("job-2");
    expect(await notificationIds(itemId)).toHaveLength(2);
  });

  it("skips the automation_error notification (but still records the failure) before any user account exists", async () => {
    const { databaseId, itemId } = await newItem("movies", { name: "Sicario", year: 2015 });
    const payload = { itemId, databaseId, config: { source: "tmdb", coverKey: "cover" } };
    await expect(
      handleProcessLibraryMetadataTask(pool, payload, failingFetcher("source unavailable"), { job: { id: "job-1" } }),
    ).rejects.toThrow("Library metadata processing failed");
    expect(await notificationIds(itemId)).toHaveLength(0);
    expect((await automationOf(itemId))?.status).toBe("error");
  });

  it("a locked item_automation row is never touched by the heartbeat", async () => {
    const { itemId } = await newItem("books", { name: "Dune" }, false);
    // Pre-seed and lock the row before anything drains: `runOnce` cascades the trigger and processing job
    // in one call, so "mid-flight" locking is not observable; pre-locking exercises the same guard
    // (`ensureItemAutomation` is a no-op once the row exists).
    await withTransaction(pool, async (client) => {
      await ensureItemAutomation(client, itemId);
      await setItemAutomationLocked(client, itemId, true);
    });
    let called = false;
    await drainQueue(libraryRegistry(), async () => {
      called = true;
      return {};
    });
    expect(called).toBe(false);
    expect((await automationOf(itemId))?.status).toBe("locked");
  });

  it.each([
    {
      outcome: "error",
      first: failingFetcher("boom"),
      settled: { status: "done", attempts: 1 }, // only failures increment the attempts
    },
    {
      outcome: "notFound",
      first: (async () => ({ status: "notFound", source: "openLibrary" })) satisfies LibraryMetadataFetcher,
      settled: { status: "done" },
    },
  ])("retries a row left in '$outcome' through the actual daily heartbeat", async ({ outcome, first, settled }) => {
    const { databaseId, itemId } = await newItem("books", { name: "Dune" }, false);
    const registry = libraryRegistry();
    await drainQueue(registry, first);
    expect((await automationOf(itemId))?.status).toBe(outcome);
    await fireRetryHeartbeat(databaseId);
    const retried: string[] = [];
    const found: LibraryMetadataFetcher = async (row) => {
      retried.push(row.id);
      return { status: "found", source: "openLibrary" };
    };
    // The heartbeat fire runs the retry sweep, which enqueues the processing job run by the second drain.
    await drainQueue(registry, found);
    await drainQueue(registry, found);
    expect(retried).toContain(itemId);
    expect(await automationOf(itemId)).toMatchObject(settled);
  });

  it("selects error and notFound for retry but leaves done and locked alone", async () => {
    const { databaseId, itemId: errored } = await newItem("books", { name: "Error" }, false);
    const missing = (await newItem("books", { name: "Missing" }, false)).itemId;
    const found = (await newItem("books", { name: "Found" }, false)).itemId;
    const locked = (await newItem("books", { name: "Locked" }, false)).itemId;
    await inTenantZero(() =>
      withTransaction(pool, async (client) => {
        for (const itemId of [errored, missing, found, locked]) await ensureItemAutomation(client, itemId);
        await markItemAutomationError(client, errored, "sourceUnavailable", "sourceUnavailable", "openLibrary");
        await markItemAutomationNotFound(client, missing, "openLibrary");
        await markItemAutomationDone(client, found, "openLibrary");
        await setItemAutomationLocked(client, locked, true);
      }),
    );
    await inTenantZero(() =>
      createLibraryMetadataRetrySweepAction(pool)(
        { databaseId, ...OPEN_LIBRARY },
        { heartbeatId: "heartbeat", projectItemId: "project" },
      ),
    );
    const keys = (ids: string[]) => ids.map((id) => `library-metadata:${id}`);
    const rows = await pool.query<{ key: string }>(
      "SELECT key FROM graphile_worker.jobs WHERE key = ANY($1::text[]) ORDER BY key",
      [keys([errored, missing, found, locked])],
    );
    expect(rows.rows.map((row) => row.key)).toEqual(keys([errored, missing]).sort());
    expect((await automationOf(found))?.status).toBe("done");
    expect((await automationOf(locked))?.status).toBe("locked");
  });

  it("does not enqueue repeated unsupported sweeps and resumes after configuration repair", async () => {
    const { databaseId, itemId } = await newItem("books", { name: "Dune" }, false);
    const registry = libraryRegistry();
    await drainQueue(registry, failingFetcher("provider unavailable"));
    const before = await automationOf(itemId);
    expect(before?.status).toBe("error");
    expect(await jobCount(itemId)).toBe("1");
    const readJob = () =>
      pool.query<Record<string, unknown>>("SELECT id, attempts, run_at FROM graphile_worker.jobs WHERE key = $1", [
        `library-metadata:${itemId}`,
      ]);
    const existing = (await readJob()).rows;
    const action = createLibraryMetadataRetrySweepAction(pool);
    const context = { heartbeatId: "heartbeat", projectItemId: "project" };
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        inTenantZero(() => action({ databaseId, source: "invalid", coverKey: "cover" }, context)),
      ).rejects.toThrow("Unsupported library metadata source configuration");
      expect((await readJob()).rows).toEqual(existing);
      expect(await automationOf(itemId)).toEqual(before);
    }
    await inTenantZero(() => action({ databaseId, ...OPEN_LIBRARY }, context));
    expect(await jobCount(itemId)).toBe("1");
    await drainQueue(registry, async () => ({ status: "notFound", source: "openLibrary" }));
    expect((await automationOf(itemId))?.status).toBe("notFound");
  });

  it("stores a per-relation rating on the Movies -> People edge, not on either item", async () => {
    const movie = await newItem("movies", { name: "Arrival", year: 2016 }, false);
    const person = await newItem("people", { name: "Alex" }, false);
    const watchedWith = (await chokePoint.listProperties(movie.databaseId)).find((p) => p.key === "watchedWith")!;
    await chokePoint.createRelation({
      relationPropertyId: watchedWith.id,
      callerItemId: movie.itemId,
      targetItemId: person.itemId,
      metadata: { rating: 4 },
    });
    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT metadata FROM item_relations WHERE item_a = $1 OR item_b = $1`,
      [movie.itemId],
    );
    expect(rows).toHaveLength(1);
    expect(z.object({ metadata: z.record(z.string(), z.unknown()) }).parse(rows[0]).metadata).toEqual({ rating: 4 });
    // Not a property on either side.
    expect((await propertiesOf(movie.databaseId, movie.itemId))?.rating).toBeUndefined();
  });

  it("excludes a soft-deleted item's errored row from the daily retry sweep's re-enqueue", async () => {
    const { databaseId, itemId } = await newItem("books", { name: "Dune" }, false);
    const registry = libraryRegistry();
    await drainQueue(registry, failingFetcher("boom"));
    expect((await automationOf(itemId))?.status).toBe("error");
    await chokePoint.softDeleteItem(databaseId, itemId);
    await fireRetryHeartbeat(databaseId);
    let called = false;
    await drainQueue(registry, async () => {
      called = true;
      return {};
    });
    expect(called).toBe(false);
    expect((await automationOf(itemId))?.status).toBe("error");
  });

  it("settles item_automation to 'done' for a job that runs against an already-deleted item", async () => {
    const { databaseId, itemId } = await newItem("books", { name: "Dune" }, false);
    await chokePoint.softDeleteItem(databaseId, itemId);
    // A job enqueued directly (e.g. already in flight when the delete happened), bypassing the retry sweep's
    // exclusion filter.
    await inTenantZero(() =>
      withTransaction(pool, (client) =>
        enqueueLibraryMetadataProcessing(client, { itemId, databaseId, config: { source: "none", coverKey: "cover" } }),
      ),
    );
    let called = false;
    await drainQueue(libraryRegistry(), async () => {
      called = true;
      return {};
    });
    expect(called).toBe(false); // the job returns before ever calling the fetcher
    expect((await automationOf(itemId))?.status).toBe("done");
  });

  const tx = <T>(work: (client: PoolClient) => Promise<T>) => withTransaction(pool, work);

  it("startItemAutomationAttempt reopens a row as pending and counts the attempt, keeping the earlier error", async () => {
    const { itemId } = await newItem("books");
    await tx((client) => recordItemAutomationFailure(client, itemId, "earlier failure", "error"));
    const started = await tx((client) => startItemAutomationAttempt(client, itemId));
    expect(started).toMatchObject({ itemId, status: "pending", error: "earlier failure", attempts: 1 });
    expect(started?.lastAttemptAt).not.toBeNull();
    expect((await tx((client) => startItemAutomationAttempt(client, itemId)))?.attempts).toBe(2);
  });

  it("startItemAutomationAttempt returns null and changes nothing on a locked or absent row", async () => {
    const { itemId } = await newItem("books");
    await tx((client) => setItemAutomationLocked(client, itemId, true));
    expect(await tx((client) => startItemAutomationAttempt(client, itemId))).toBeNull();
    expect(await automationOf(itemId)).toMatchObject({ status: "locked", attempts: 0, lastAttemptAt: null });
    const absentId = "00000000-0000-4000-8000-000000000000";
    expect(await tx((client) => startItemAutomationAttempt(client, absentId))).toBeNull();
  });

  it("recordItemAutomationFailure writes the error and status without counting an attempt, and never touches a locked row", async () => {
    const { itemId } = await newItem("books");
    for (const [error, status] of [
      ["transient", "pending"],
      ["permanent", "error"],
    ] as const) {
      expect(await tx((client) => recordItemAutomationFailure(client, itemId, error, status))).toBe(true);
      expect(await automationOf(itemId)).toMatchObject({ status, error, attempts: 0 });
    }
    await tx((client) => setItemAutomationLocked(client, itemId, true));
    expect(await tx((client) => recordItemAutomationFailure(client, itemId, "ignored", "error"))).toBe(false);
    expect(await automationOf(itemId)).toMatchObject({ status: "locked", error: "permanent" });
  });

  it("unlocking a row only transitions it if it was actually locked, never clobbering 'done'/'error'", async () => {
    const { itemId } = await newItem("books");
    await tx((client) => markItemAutomationDone(client, itemId));
    // Unlocking a row that was never locked (already 'done') is a no-op, not a reset to 'pending'.
    expect((await tx((client) => setItemAutomationLocked(client, itemId, false))).status).toBe("done");
    // Locking then unlocking does reach 'pending' — the one real lock/unlock transition.
    await tx((client) => setItemAutomationLocked(client, itemId, true));
    expect((await automationOf(itemId))?.status).toBe("locked");
    expect((await tx((client) => setItemAutomationLocked(client, itemId, false))).status).toBe("pending");
  });
});

describe("library automation_error recipient in a tenant", () => {
  let runtimePool: Pool;

  // The first describe's `afterAll` ended the shared pool, so this block opens and closes its own.
  beforeAll(async () => {
    pool = getTestPool();
    runtimePool = await runInTenant(getTenantZeroId(), () => createRuntimeRolePool(pool, "alldots_data"));
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
    const payload = await runInTenant(tenantB, async () => {
      await seedSystem(runtimePool);
      const { rows } = await runtimePool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [
        "movies",
      ]);
      const databaseId = rows[0]!.id;
      const item = await createChokePoint(runtimePool).createItem({
        databaseId,
        properties: { name: "Sicario", year: 2015 },
      });
      return { itemId: item.id, databaseId, config: { source: "tmdb", coverKey: "cover" } };
    });
    await runInTenant(tenantB, () =>
      withTransaction(runtimePool, (client) => enqueueLibraryMetadataProcessing(client, payload)),
    );
    expect(
      await runInTenant(tenantB, () =>
        withTransaction(runtimePool, (client) => getItemAutomation(client, payload.itemId)),
      ),
    ).toMatchObject({ status: "pending" });

    await expect(
      runInTenant(tenantB, () =>
        handleProcessLibraryMetadataTask(runtimePool, payload, failingFetcher("source unavailable"), {
          job: { id: "job-b" },
        }),
      ),
    ).rejects.toThrow("Library metadata processing failed");

    const { rows } = await pool.query<{ user_id: string; kind: string; tenant_id: string }>(
      `SELECT user_id, kind, tenant_id FROM notifications WHERE source_id = $1`,
      [payload.itemId],
    );
    expect(rows).toEqual([{ user_id: userB.id, kind: "automation_error", tenant_id: tenantB }]);
    expect(rows[0]?.user_id).not.toBe(userA.id);
  });
});

describe("Books year and ISBN properties", () => {
  let admin: Pool;
  let runtime: Pool;
  let tenantId: string;
  let booksId: string;
  beforeEach(async () => {
    admin ??= getTestPool();
    runtime ??= await createRuntimeRolePool(admin, "alldots_data");
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

  it("seeds both Books fields for a fresh tenant through the runtime role", async () =>
    runInTenant(tenantId, async () => {
      const { rows } = await runtime.query<{ key: string; type: string; owner: string; name: string | null }>(
        "SELECT key, type, owner, name FROM properties WHERE database_id = $1 AND key IN ('isbn', 'year') ORDER BY key",
        [booksId],
      );
      expect(rows).toEqual([
        { key: "isbn", type: "text", owner: "user", name: null },
        { key: "year", type: "number", owner: "user", name: null },
      ]);
    }));
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
});

describe("library cover override", () => {
  const LIBRARY_CASES = [
    {
      moduleId: "books",
      source: "openLibrary",
      fill: { author: "Frank Herbert" },
      config: { source: "openLibrary", coverKey: "cover", authorKey: "author" },
    },
    {
      moduleId: "movies",
      source: "tmdb",
      fill: { year: 2021 },
      config: { source: "tmdb", coverKey: "cover", yearKey: "year" },
    },
  ] as const;
  type LibraryCase = (typeof LIBRARY_CASES)[number];
  let storageRoot: string;
  let storage: BlobStorageWriter;

  beforeAll(() => {
    pool = getTestPool();
    chokePoint = createChokePoint(pool);
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await seedSystem(pool);
    storageRoot = await mkdtemp(join(tmpdir(), "alldots-library-cover-override-"));
    storage = new LocalFsBlobStorageWriter(storageRoot);
  });

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function currentProperties(databaseId: string, itemId: string): Promise<Record<string, unknown>> {
    const properties = await propertiesOf(databaseId, itemId);
    if (!properties) throw new Error(`item ${itemId} is missing`);
    return properties;
  }

  async function newBlobId(): Promise<string> {
    const blob = await inTenantZero(() =>
      withTransaction(pool, async (client) =>
        createBlob(client, {
          mimeType: "image/png",
          byteSize: 4,
          storageKey: await tenantBlobStorageKey(client, `blobs/${randomUUID()}`),
        }),
      ),
    );
    return blob.id;
  }

  const patch = (databaseId: string, itemId: string, propertiesPatch: Record<string, unknown>) =>
    chokePoint.updateItem({ databaseId, itemId, propertiesPatch });

  function runJob(c: LibraryCase, databaseId: string, itemId: string) {
    const fetcher: LibraryMetadataFetcher = async () => ({
      status: "found",
      source: c.source,
      ...c.fill,
      cover: { mimeType: "image/jpeg", bytes: JPEG },
    });
    return processMetadata(itemId, databaseId, c.config, fetcher, storage);
  }

  describe.each(LIBRARY_CASES)("$moduleId", (c) => {
    it("keeps a chosen cover through a job run that still fills an empty field and writes the system cover", async () => {
      const { databaseId, itemId } = await newItem(c.moduleId, { name: "Cover probe" });
      const blobId = await newBlobId();
      const filesItems = async () =>
        (
          await pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM items WHERE database_id = (SELECT id FROM databases WHERE owner_module_id = 'files')",
          )
        ).rows[0]?.n;
      const filesBefore = await filesItems();
      await patch(databaseId, itemId, { coverOverride: { blobId }, coverSource: "userPhoto" });
      expect(await currentProperties(databaseId, itemId)).toMatchObject({
        coverOverride: { blobId },
        coverSource: "userPhoto",
      });
      // The photo is a blob of the item, not a file of the user: no Files item is created for it.
      expect(await filesItems()).toBe(filesBefore);

      await runJob(c, databaseId, itemId);

      const after = await currentProperties(databaseId, itemId);
      expect(after).toMatchObject({ coverOverride: { blobId }, coverSource: "userPhoto", ...c.fill });
      expect(z.object({ blobId: z.uuid() }).parse(after.cover).blobId).not.toBe(blobId);
      expect(await automationOf(itemId)).toMatchObject({ status: "done", source: c.source });
    });

    it("keeps a removed cover removed through a job run and leaves the item unlocked", async () => {
      const { databaseId, itemId } = await newItem(c.moduleId, { name: "Cover probe" });
      await patch(databaseId, itemId, { coverRemoved: true });
      expect((await automationOf(itemId))?.status).toBe("pending");

      await runJob(c, databaseId, itemId);

      const after = await currentProperties(databaseId, itemId);
      expect(after).toMatchObject({ coverRemoved: true, ...c.fill });
      expect(after.cover).toBeDefined();
      expect((await automationOf(itemId))?.status).toBe("done");
    });

    describe("refused writes", () => {
      it("answers a 400 naming the field and leaves the item as it was for each invalid combination", async () => {
        const { databaseId, itemId } = await newItem(c.moduleId, { name: "Cover probe" });
        const blobId = await newBlobId();
        const before = await currentProperties(databaseId, itemId);
        const refused: Array<[label: string, propertiesPatch: Record<string, unknown>, field: string]> = [
          [
            "an override of a blob that does not exist",
            { coverOverride: { blobId: randomUUID() }, coverSource: "userImage" },
            "coverOverride",
          ],
          [
            "an override that is not an object",
            { coverOverride: "cover.png", coverSource: "userImage" },
            "coverOverride",
          ],
          ["an override without a blob id", { coverOverride: {}, coverSource: "userImage" }, "coverOverride"],
          [
            "an override whose blob id is not a UUID",
            { coverOverride: { blobId: "not-a-uuid" }, coverSource: "userImage" },
            "coverOverride",
          ],
          ["an override without a source", { coverOverride: { blobId } }, "coverSource"],
          ["an override with a null source", { coverOverride: { blobId }, coverSource: null }, "coverSource"],
          ["a source outside the options", { coverSource: "bogus" }, "coverSource"],
          ["a removed flag that is not a boolean", { coverRemoved: "yes" }, "coverRemoved"],
          [
            "a removal together with an override",
            { coverRemoved: true, coverOverride: { blobId }, coverSource: "userPhoto" },
            "coverRemoved",
          ],
        ];
        for (const [label, propertiesPatch, field] of refused) {
          const error = await patch(databaseId, itemId, propertiesPatch).catch((e: unknown) => e);
          expect(error, label).toBeInstanceOf(ValidationError);
          expect(error, label).toMatchObject({ status: 400, details: { field } });
          expect(await currentProperties(databaseId, itemId), label).toEqual(before);
        }
      });

      it("refuses a removal while an override is stored and a source cleared while an override is stored", async () => {
        const { databaseId, itemId } = await newItem(c.moduleId, { name: "Cover probe" });
        const blobId = await newBlobId();
        await patch(databaseId, itemId, { coverOverride: { blobId }, coverSource: "userImage" });
        const before = await currentProperties(databaseId, itemId);
        for (const [propertiesPatch, field] of [
          [{ coverRemoved: true }, "coverRemoved"],
          [{ coverSource: null }, "coverSource"],
        ] as const) {
          await expect(patch(databaseId, itemId, propertiesPatch)).rejects.toMatchObject({
            status: 400,
            details: { field },
          });
        }
        expect(await currentProperties(databaseId, itemId)).toEqual(before);
      });

      it("refuses an invalid override on create and creates no item", async () => {
        const databaseId = await getDatabaseIdByModule(c.moduleId);
        const blobId = await newBlobId();
        for (const [properties, field] of [
          [{ coverOverride: { blobId } }, "coverSource"],
          [{ coverOverride: { blobId: randomUUID() }, coverSource: "userImage" }, "coverOverride"],
          [{ coverRemoved: true, coverOverride: { blobId }, coverSource: "userImage" }, "coverRemoved"],
        ] as const) {
          await expect(
            inTenantZero(() =>
              chokePoint.createItem({ databaseId, properties: { name: "Refused create", ...properties } }),
            ),
          ).rejects.toMatchObject({ status: 400, details: { field } });
        }
        const probes = await pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM items WHERE database_id = $1 AND properties->>'name' = 'Refused create'",
          [databaseId],
        );
        expect(probes.rows[0]?.n).toBe(0);
        const created = await newItem(
          c.moduleId,
          { name: "Accepted create", coverOverride: { blobId }, coverSource: "userImage" },
          false,
        );
        expect(await currentProperties(databaseId, created.itemId)).toMatchObject({ coverOverride: { blobId } });
      });
    });

    describe("accepted writes", () => {
      it("clears a stored removal when an override is set, and adds no removal flag otherwise", async () => {
        const { databaseId, itemId } = await newItem(c.moduleId, { name: "Cover probe" });
        const first = await newBlobId();
        await patch(databaseId, itemId, { coverOverride: { blobId: first }, coverSource: "userPhoto" });
        expect(Object.hasOwn(await currentProperties(databaseId, itemId), "coverRemoved")).toBe(false);

        await patch(databaseId, itemId, { coverOverride: null });
        await patch(databaseId, itemId, { coverRemoved: true });
        expect((await currentProperties(databaseId, itemId)).coverRemoved).toBe(true);
        const second = await newBlobId();
        await patch(databaseId, itemId, { coverOverride: { blobId: second }, coverSource: "userImage" });
        expect(await currentProperties(databaseId, itemId)).toMatchObject({
          coverOverride: { blobId: second },
          coverSource: "userImage",
          coverRemoved: false,
        });
      });

      it("accepts a removal that clears the override in the same write and an explicit removed flag of false", async () => {
        const { databaseId, itemId } = await newItem(c.moduleId, { name: "Cover probe" });
        const blobId = await newBlobId();
        await patch(databaseId, itemId, { coverOverride: { blobId }, coverSource: "userPhoto" });
        await patch(databaseId, itemId, { coverRemoved: true, coverOverride: null });
        expect(await currentProperties(databaseId, itemId)).toMatchObject({ coverRemoved: true, coverOverride: null });
        await patch(databaseId, itemId, { coverOverride: { blobId }, coverRemoved: false, coverSource: "userPhoto" });
        expect(await currentProperties(databaseId, itemId)).toMatchObject({
          coverRemoved: false,
          coverOverride: { blobId },
        });
      });

      it("replaces the override and keeps the stored source when the write names no source", async () => {
        const { databaseId, itemId } = await newItem(c.moduleId, { name: "Cover probe" });
        const [first, second] = [await newBlobId(), await newBlobId()];
        await patch(databaseId, itemId, { coverOverride: { blobId: first }, coverSource: "userPhoto" });
        await patch(databaseId, itemId, { coverOverride: { blobId: second } });
        expect(await currentProperties(databaseId, itemId)).toMatchObject({
          coverOverride: { blobId: second },
          coverSource: "userPhoto",
        });
      });

      it("leaves the cover properties alone when a write names none of them", async () => {
        const { databaseId, itemId } = await newItem(c.moduleId, { name: "Cover probe" });
        await patch(databaseId, itemId, { coverRemoved: true });
        await patch(databaseId, itemId, { rating: 3 });
        expect(await currentProperties(databaseId, itemId)).toMatchObject({ coverRemoved: true, rating: 3 });
      });
    });

    it("a write prepared for approval carries the same added value as the write and the same refusals, without a blob lookup", async () => {
      const prepare = async (itemId: string, values: Record<string, unknown>) => {
        const databaseId = await getDatabaseIdByModule(c.moduleId);
        const database = await withTransaction(pool, (client) => getDatabase(client, databaseId));
        const stored = await chokePoint.getItem(databaseId, itemId);
        if (!database || !stored) throw new Error("the database or the item is missing");
        return prepareUserItemPatch(await chokePoint.listProperties(databaseId), values, database, stored, "UTC");
      };
      const plain = await newItem(c.moduleId, { name: "Cover probe" });
      const removed = await newItem(c.moduleId, { name: "Cover probe" });
      await patch(removed.databaseId, removed.itemId, { coverRemoved: true });
      const unknownBlob = randomUUID();

      const prepared = await prepare(removed.itemId, {
        coverOverride: { blobId: unknownBlob },
        coverSource: "userImage",
      });
      expect(prepared.patch).toEqual({
        coverOverride: { blobId: unknownBlob },
        coverSource: "userImage",
        coverRemoved: false,
      });
      expect(prepared.deferredKeys).toEqual([]);
      await expect(prepare(plain.itemId, { coverOverride: { blobId: unknownBlob } })).rejects.toMatchObject({
        details: { field: "coverSource" },
      });
    });
  });

  describe("reference safety of the chosen cover", () => {
    async function trashedFilesItem(blobId: string): Promise<void> {
      const { databaseId, itemId } = await newItem("files", { name: "Same bytes", file: { blobId } }, false);
      await chokePoint.softDeleteItem(databaseId, itemId);
      // Fixture SQL: the only way to age a trashed row past the 30 days retention.
      await pool.query("UPDATE items SET deleted_at = now() - interval '31 days' WHERE id = $1 AND database_id = $2", [
        itemId,
        databaseId,
      ]);
    }

    const blobRows = async (blobId: string) =>
      (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM blobs WHERE id = $1", [blobId])).rows[0]?.n;

    it.each(["coverOverride", "cover"] as const)(
      "keeps the blob %s names when a Files item with the same bytes is purged, and deletes it once nothing names it",
      async (propertyKey) => {
        const { databaseId, itemId } = await newItem("books", { name: "Cover probe" });
        const blobId = await newBlobId();
        const writeReference = (value: { blobId: string } | null) =>
          propertyKey === "coverOverride"
            ? patch(databaseId, itemId, { coverOverride: value, ...(value ? { coverSource: "userPhoto" } : {}) })
            : inTenantZero(() =>
                withTransaction(pool, (client) =>
                  updateItemWithClient(
                    client,
                    { databaseId, itemId, propertiesPatch: { cover: value } },
                    { allowedSystemKeys: ["cover"] },
                  ),
                ),
              );
        const deleteMock = vi.fn(async (_storageKey: string) => {});
        const fake: BlobStorageWriter = {
          writeStream: () => Promise.reject(new Error("not used by the purge")),
          readStream: () => {
            throw new Error("not used by the purge");
          },
          delete: deleteMock,
        };
        await writeReference({ blobId });
        await trashedFilesItem(blobId);
        expect(await inTenantZero(() => purgeExpiredTrash(pool, fake))).toBe(1);
        expect(await blobRows(blobId)).toBe(1);
        expect(deleteMock).not.toHaveBeenCalled();

        await writeReference(null);
        await trashedFilesItem(blobId);
        expect(await inTenantZero(() => purgeExpiredTrash(pool, fake))).toBe(1);
        expect(await blobRows(blobId)).toBe(0);
        expect(deleteMock).toHaveBeenCalledTimes(1);
      },
    );
  });
});
