import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runOnce } from "@semprec/queue";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { ForbiddenError } from "../errors.js";
import { createActionRegistry } from "../scheduler/actions.js";
import { sweepDueHeartbeats } from "../scheduler/schedulerStore.js";
import { createCoreTaskList } from "../worker.js";
import {
  createLibraryMetadataTriggerAction,
  createLibraryMetadataRetrySweepAction,
  LIBRARY_METADATA_TRIGGER_ACTION_ID,
  LIBRARY_METADATA_RETRY_SWEEP_ACTION_ID,
} from "../library/libraryMetadataActions.js";
import { ensureItemAutomation, getItemAutomation, markItemAutomationDone, setItemAutomationLocked } from "../library/itemAutomationStore.js";
import { enqueueLibraryMetadataProcessing, type LibraryMetadataFetcher } from "../library/libraryMetadataJob.js";

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
  const { rows } = await pool.query("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  return rows[0].id;
}

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

    expect(books.map((p) => p.key).sort()).toEqual(["author", "cover", "name", "rating", "status"]);
    expect(movies.map((p) => p.key).sort()).toEqual(
      ["cover", "name", "notes", "rating", "secondaryRating", "sourceUrl", "status", "type", "watchedWith", "year"].sort(),
    );

    expect(books.find((p) => p.key === "cover")).toMatchObject({ type: "image", owner: "system" });
    expect(movies.find((p) => p.key === "year")).toMatchObject({ type: "number", owner: "user" });
    expect(movies.find((p) => p.key === "secondaryRating")).toMatchObject({ type: "number", owner: "system" });
    expect(movies.find((p) => p.key === "sourceUrl")).toMatchObject({ type: "url", owner: "system" });

    const booksViews = await chokePoint.listViewsByDatabase(booksId);
    expect(booksViews).toHaveLength(1);
    expect(booksViews[0].type).toBe("library-grid");
    expect(booksViews[0].config).toMatchObject({ coverKey: "cover", subtitleKey: "author", statusKey: "status" });

    const moviesViews = await chokePoint.listViewsByDatabase(moviesId);
    expect(moviesViews[0].config).toMatchObject({ coverKey: "cover", subtitleKey: "year", secondaryRatingKey: "secondaryRating" });
  });

  it("rejects writing owner:'system' library fields through the generic create/update path", async () => {
    const booksId = await getDatabaseIdByModule("books");
    await expect(
      chokePoint.createItem({ databaseId: booksId, properties: { name: "Dune", cover: { blobId: "x" } } }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const item = await chokePoint.createItem({ databaseId: booksId, properties: { name: "Dune" } });
    await expect(
      chokePoint.updateItem({ databaseId: booksId, itemId: item.id, propertiesPatch: { cover: { blobId: "x" } } }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("creating a library item drives processLibraryMetadata end to end, storing a real blob as the cover", async () => {
    const booksId = await getDatabaseIdByModule("books");
    const registry = libraryRegistry();
    const item = await chokePoint.createItem({ databaseId: booksId, properties: { name: "Dune", author: "Frank Herbert" } });

    // `runOnce` drains cascading enqueues within one call: the choke-point's onItemEvent
    // trigger -> heartbeatFire -> our trigger action (seeds item_automation, enqueues the
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
    const item = await chokePoint.createItem({ databaseId: moviesId, properties: { name: "Sicario", year: 2015 } });

    const failingFetcher: LibraryMetadataFetcher = async () => {
      throw new Error("source unavailable");
    };
    await drainQueue(registry, failingFetcher);

    const automation = await withTransaction(pool, (client) => getItemAutomation(client, item.id));
    expect(automation?.status).toBe("error");
    expect(automation?.error).toBe("source unavailable");
    expect(automation?.attempts).toBe(1);
  });

  it("a locked item_automation row is never touched by the heartbeat", async () => {
    const booksId = await getDatabaseIdByModule("books");
    const registry = libraryRegistry();
    const item = await chokePoint.createItem({ databaseId: booksId, properties: { name: "Dune" } });

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
    const item = await chokePoint.createItem({ databaseId: booksId, properties: { name: "Dune" } });

    await drainQueue(registry, async () => {
      throw new Error("boom");
    });
    expect((await withTransaction(pool, (client) => getItemAutomation(client, item.id)))?.status).toBe("error");

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM project_heartbeats WHERE action_id = $1 AND action_config ->> 'databaseId' = $2`,
      [LIBRARY_METADATA_RETRY_SWEEP_ACTION_ID, booksId],
    );
    expect(rows).toHaveLength(1);
    await pool.query("UPDATE project_heartbeats SET next_fire_at = now() - interval '1 minute' WHERE id = $1", [rows[0].id]);
    await withTransaction(pool, (client) => sweepDueHeartbeats(client));

    await drainQueue(registry); // heartbeatFire -> retry sweep action -> re-enqueues processLibraryMetadata
    await drainQueue(registry, async () => ({})); // the re-enqueued job itself, now succeeding

    const recovered = await withTransaction(pool, (client) => getItemAutomation(client, item.id));
    expect(recovered?.status).toBe("done");
    expect(recovered?.attempts).toBe(1); // unchanged by the successful retry, only failures increment it
  });

  it("stores a per-relation rating on the Movies -> People edge, not on either item", async () => {
    const moviesId = await getDatabaseIdByModule("movies");
    const peopleId = await getDatabaseIdByModule("people");

    const movie = await chokePoint.createItem({ databaseId: moviesId, properties: { name: "Arrival", year: 2016 } });
    const person = await chokePoint.createItem({ databaseId: peopleId, properties: { name: "Alex" } });

    const watchedWith = (await chokePoint.listProperties(moviesId)).find((p) => p.key === "watchedWith")!;
    await chokePoint.createRelation({ relationPropertyId: watchedWith.id, itemId: movie.id, targetItemId: person.id, metadata: { rating: 4 } });

    const { rows } = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM item_relations WHERE item_a = $1 OR item_b = $1`,
      [movie.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toEqual({ rating: 4 });

    // Not a property on either side.
    expect((await chokePoint.getItem(moviesId, movie.id))?.properties.rating).toBeUndefined();
  });

  it("excludes a soft-deleted item's errored row from the daily retry sweep's re-enqueue", async () => {
    const booksId = await getDatabaseIdByModule("books");
    const registry = libraryRegistry();
    const item = await chokePoint.createItem({ databaseId: booksId, properties: { name: "Dune" } });

    await drainQueue(registry, async () => {
      throw new Error("boom");
    });
    expect((await withTransaction(pool, (client) => getItemAutomation(client, item.id)))?.status).toBe("error");

    await chokePoint.softDeleteItem(booksId, item.id);

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM project_heartbeats WHERE action_id = $1 AND action_config ->> 'databaseId' = $2`,
      [LIBRARY_METADATA_RETRY_SWEEP_ACTION_ID, booksId],
    );
    await pool.query("UPDATE project_heartbeats SET next_fire_at = now() - interval '1 minute' WHERE id = $1", [rows[0].id]);
    await withTransaction(pool, (client) => sweepDueHeartbeats(client));

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
    const item = await chokePoint.createItem({ databaseId: booksId, properties: { name: "Dune" } });
    await chokePoint.softDeleteItem(booksId, item.id);

    // A job enqueued directly (e.g. one already in flight when the delete happened),
    // bypassing the retry sweep's exclusion filter entirely.
    let called = false;
    await withTransaction(pool, (client) =>
      enqueueLibraryMetadataProcessing(client, { itemId: item.id, databaseId: booksId, config: { source: "none", coverKey: "cover" } }),
    );
    await drainQueue(registry, async () => {
      called = true;
      return {};
    });
    expect(called).toBe(false); // the job returns before ever calling the fetcher

    const settled = await withTransaction(pool, (client) => getItemAutomation(client, item.id));
    expect(settled?.status).toBe("done");
  });

  it("unlocking a row only transitions it if it was actually locked, never clobbering 'done'/'error'", async () => {
    const booksId = await getDatabaseIdByModule("books");
    const item = await chokePoint.createItem({ databaseId: booksId, properties: { name: "Dune" } });

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
