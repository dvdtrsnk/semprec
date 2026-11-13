import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createBlob, tenantBlobStorageKey } from "../blobs/blobsStore.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { runTenantCutoverMigrations } from "../db/tenantCutoverMigrations.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import {
  ensureItemAutomation,
  getItemAutomation,
  markItemAutomationError,
  resetItemAutomationToPending,
  setItemAutomationLocked,
} from "../library/itemAutomationStore.js";
import { createLibraryAutomationRetryRouteHandler } from "../library/libraryAutomationRouteHandlers.js";
import { runLibraryCoverOverrideCutoverMigration } from "../library/libraryCoverOverrideCutoverMigration.js";
import {
  LIBRARY_METADATA_RETRY_SWEEP_ACTION_ID,
  LIBRARY_METADATA_TRIGGER_ACTION_ID,
} from "../library/libraryMetadataActions.js";
import { LibraryMetadataConfigurationError } from "../library/libraryMetadataConfig.js";
import type { LibraryMetadataFetcher } from "../library/libraryMetadataJob.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import { generateSchemaProjection } from "../manifest/schemaProjection.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import { createActionRegistry } from "../scheduler/actions.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { LocalFsBlobStorageWriter } from "../mail/blobStorage.js";
import { createCoreTaskList } from "../worker.js";
import {
  createLibraryMetadataRetrySweepAction,
  createLibraryMetadataTriggerAction,
} from "../library/libraryMetadataActions.js";

const JOB_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
const COVER_KEYS = ["coverOverride", "coverRemoved", "coverSource"] as const;

let admin: Pool;
let runtime: Pool;
let tenantId: string;
let storageRoot: string;

interface SeededLibrary {
  booksId: string;
  moviesId: string;
}

interface PropertySnapshot {
  key: string;
  type: string;
  owner: string;
  name: string | null;
  config: unknown;
  locked: boolean;
  owner_process: string | null;
}

/** The Books and Movies databases of the tenant `id`, seeded through the runtime role. */
async function seedTenantLibrary(id: string): Promise<SeededLibrary> {
  return runInTenant(id, async () => {
    await seedSystem(runtime);
    const { rows } = await runtime.query<{ id: string; owner_module_id: string }>(
      "SELECT id, owner_module_id FROM databases WHERE owner_module_id = ANY($1::text[])",
      [["books", "movies"]],
    );
    const idOf = (moduleId: string): string => {
      const row = rows.find((candidate) => candidate.owner_module_id === moduleId);
      if (!row) throw new Error(`${moduleId} is missing`);
      return row.id;
    };
    return { booksId: idOf("books"), moviesId: idOf("movies") };
  });
}

describe("library cover cutover and retry (issue gh-1793)", () => {
  let library: SeededLibrary;

  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenantId = await createTestTenant(admin);
    library = await seedTenantLibrary(tenantId);
    storageRoot = await mkdtemp(join(tmpdir(), "semprec-library-retry-"));
  });

  afterEach(async () => {
    setInvalidationHook(() => {});
    await rm(storageRoot, { recursive: true, force: true });
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  it("runs as a role that is neither superuser nor BYPASSRLS", async () => {
    const { rows } = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  describe("cutover", () => {
    async function propertySnapshot(databaseId: string): Promise<PropertySnapshot[]> {
      const { rows } = await runtime.query<PropertySnapshot>(
        `SELECT key, type, owner, name, config, locked, owner_process FROM properties
         WHERE database_id = $1 AND key = ANY($2::text[]) ORDER BY key`,
        [databaseId, [...COVER_KEYS]],
      );
      return rows;
    }

    async function identities(databaseId: string): Promise<Array<{ id: string; xmin: string }>> {
      const { rows } = await runtime.query<{ id: string; xmin: string }>(
        `SELECT id, xmin::text AS xmin FROM properties WHERE database_id = $1 AND key = ANY($2::text[])
         UNION ALL SELECT id, xmin::text FROM views WHERE database_id = $1 ORDER BY id`,
        [databaseId, [...COVER_KEYS]],
      );
      return rows;
    }

    async function viewConfigs(databaseId: string): Promise<Array<Record<string, unknown>>> {
      const { rows } = await runtime.query<{ config: Record<string, unknown> }>(
        "SELECT config FROM views WHERE database_id = $1 AND type = 'library-grid' ORDER BY id",
        [databaseId],
      );
      return rows.map((row) => row.config);
    }

    /** Fixture SQL: puts a tenant back to the schema of a build that had no cover properties. */
    async function stripCoverSchema(databaseId: string): Promise<void> {
      await runtime.query("DELETE FROM properties WHERE database_id = $1 AND key = ANY($2::text[])", [
        databaseId,
        [...COVER_KEYS],
      ]);
      await runtime.query(
        "UPDATE views SET config = config - 'coverOverrideKey' - 'coverRemovedKey' - 'coverSourceKey' WHERE database_id = $1",
        [databaseId],
      );
    }

    it("gives a tenant seeded before them the same properties and view keys as a fresh seed, through the runner", async () => {
      const [freshBooks, freshMovies] = await runInTenant(tenantId, async () => [
        await propertySnapshot(library.booksId),
        await propertySnapshot(library.moviesId),
      ]);
      expect(freshBooks.map((property) => property.key)).toEqual([...COVER_KEYS]);
      await runInTenant(tenantId, async () => {
        await stripCoverSchema(library.booksId);
        await stripCoverSchema(library.moviesId);
        expect(await propertySnapshot(library.booksId)).toEqual([]);
        expect((await viewConfigs(library.moviesId))[0]).not.toHaveProperty("coverOverrideKey");
      });

      await runAsSystem("test library cover cutover", () => runTenantCutoverMigrations(runtime));

      await runInTenant(tenantId, async () => {
        expect(await propertySnapshot(library.booksId)).toEqual(freshBooks);
        expect(await propertySnapshot(library.moviesId)).toEqual(freshMovies);
        for (const databaseId of [library.booksId, library.moviesId]) {
          expect((await viewConfigs(databaseId))[0]).toMatchObject({
            coverOverrideKey: "coverOverride",
            coverRemovedKey: "coverRemoved",
            coverSourceKey: "coverSource",
          });
        }
      });
    });

    it("changes nothing on a second run", async () => {
      await runInTenant(tenantId, async () => {
        await stripCoverSchema(library.booksId);
        await stripCoverSchema(library.moviesId);
        await runLibraryCoverOverrideCutoverMigration(runtime);
        const first = [await identities(library.booksId), await identities(library.moviesId)];
        await runLibraryCoverOverrideCutoverMigration(runtime);
        expect([await identities(library.booksId), await identities(library.moviesId)]).toEqual(first);
      });
    });

    it("keeps a property that exists and a view key the tenant already set", async () => {
      await runInTenant(tenantId, async () => {
        await stripCoverSchema(library.booksId);
        await runtime.query(
          `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
           VALUES ($1, 'coverRemoved', 'Own name', 'checkbox', '{}'::jsonb, false, 'user', NULL)`,
          [library.booksId],
        );
        await runtime.query(
          'UPDATE views SET config = config || \'{"coverOverrideKey": "ownCover"}\'::jsonb WHERE database_id = $1',
          [library.booksId],
        );
        const existing = (await propertySnapshot(library.booksId)).find((property) => property.key === "coverRemoved");

        await runLibraryCoverOverrideCutoverMigration(runtime);

        const upgraded = await propertySnapshot(library.booksId);
        expect(upgraded.map((property) => property.key)).toEqual([...COVER_KEYS]);
        expect(upgraded.find((property) => property.key === "coverRemoved")).toEqual(existing);
        expect((await viewConfigs(library.booksId))[0]).toMatchObject({
          coverOverrideKey: "ownCover",
          coverRemovedKey: "coverRemoved",
          coverSourceKey: "coverSource",
        });
      });
    });

    it("checks the merged view config with the library-grid schema and rolls the whole cutover back when it is invalid", async () => {
      await runInTenant(tenantId, async () => {
        await stripCoverSchema(library.booksId);
        // Fixture SQL: a config that the view type's schema refuses, which a view write never leaves behind.
        await runtime.query("UPDATE views SET config = config - 'coverKey' WHERE database_id = $1", [library.booksId]);

        await expect(runLibraryCoverOverrideCutoverMigration(runtime)).rejects.toBeInstanceOf(ValidationError);

        expect(await propertySnapshot(library.booksId)).toEqual([]);
        expect((await viewConfigs(library.booksId))[0]).not.toHaveProperty("coverOverrideKey");
      });
    });

    it("leaves another tenant unchanged and skips a tenant without Books and Movies", async () => {
      const other = await createTestTenant(admin);
      const otherLibrary = await seedTenantLibrary(other);
      await runInTenant(other, () => stripCoverSchema(otherLibrary.booksId));
      const empty = await createTestTenant(admin);
      await runInTenant(tenantId, async () => {
        await stripCoverSchema(library.booksId);
        await runLibraryCoverOverrideCutoverMigration(runtime);
        expect((await propertySnapshot(library.booksId)).map((property) => property.key)).toEqual([...COVER_KEYS]);
      });
      await runInTenant(other, async () => {
        expect(await propertySnapshot(otherLibrary.booksId)).toEqual([]);
      });
      await runInTenant(empty, () => runLibraryCoverOverrideCutoverMigration(runtime));
    });

    it.each(["cs", "en"] as const)(
      "resolves the property names and source options in %s through the schema projection",
      async (locale) => {
        const registry = await loadFullModuleRegistry();
        const expected =
          locale === "cs"
            ? {
                override: "Vybraná obálka",
                removed: "Obálka odebrána",
                source: "Zdroj obálky",
                userPhoto: "Vlastní fotka",
              }
            : { override: "Chosen cover", removed: "Cover removed", source: "Cover source", userPhoto: "Own photo" };
        const schema = await runInTenant(tenantId, () =>
          withTransaction(runtime, (client) => generateSchemaProjection(client, registry, { locale })),
        );
        for (const databaseId of [library.booksId, library.moviesId]) {
          const properties = schema.databases.find((database) => database.databaseId === databaseId)?.properties;
          expect(properties?.find((property) => property.key === "coverOverride")?.name).toBe(expected.override);
          expect(properties?.find((property) => property.key === "coverRemoved")?.name).toBe(expected.removed);
          const source = properties?.find((property) => property.key === "coverSource");
          expect(source?.name).toBe(expected.source);
          expect(source?.options?.map((option) => option.key)).toEqual(["candidate", "userPhoto", "userImage"]);
          expect(source?.options?.find((option) => option.key === "userPhoto")?.label).toBe(expected.userPhoto);
          expect(source?.options?.every((option) => option.label !== option.key)).toBe(true);
        }
      },
    );
  });

  it("refuses an override of a blob of another tenant like one that does not exist", async () => {
    const other = await createTestTenant(admin);
    const otherLibrary = await seedTenantLibrary(other);
    const blobIn = (scope: string) =>
      runInTenant(scope, () =>
        withTransaction(runtime, async (client) =>
          createBlob(client, {
            mimeType: "image/png",
            byteSize: 4,
            storageKey: await tenantBlobStorageKey(client, `blobs/${randomUUID()}`),
          }),
        ),
      );
    const foreignBlob = await blobIn(other);
    const api = createChokePoint(runtime);
    const book = (scope: string, databaseId: string) =>
      runInTenant(scope, () => api.createItem({ databaseId, properties: { name: "Book" } }));
    const [own, theirs] = [await book(tenantId, library.booksId), await book(other, otherLibrary.booksId)];
    const write = (scope: string, databaseId: string, itemId: string, blobId: string) =>
      runInTenant(scope, () =>
        api.updateItem({
          databaseId,
          itemId,
          propertiesPatch: { coverOverride: { blobId }, coverSource: "userPhoto" },
        }),
      );

    const foreign = await write(tenantId, library.booksId, own.id, foreignBlob.id).catch((e: unknown) => e);
    const unknown = await write(tenantId, library.booksId, own.id, randomUUID()).catch((e: unknown) => e);

    expect(foreign).toBeInstanceOf(ValidationError);
    expect(foreign).toMatchObject({ status: 400, details: { field: "coverOverride" } });
    expect(unknown).toMatchObject({ status: 400, details: { field: "coverOverride" } });
    expect((foreign as Error).message).toBe((unknown as Error).message);
    // The blob's own tenant can use it, so the refusal above was the tenant boundary.
    const accepted = await write(other, otherLibrary.booksId, theirs.id, foreignBlob.id);
    expect(accepted.properties.coverOverride).toEqual({ blobId: foreignBlob.id });
  });

  it("refuses to reset an automation row that does not exist", async () => {
    await runInTenant(tenantId, () =>
      withTransaction(runtime, async (client) => {
        await expect(resetItemAutomationToPending(client, randomUUID())).rejects.toThrow("vanished before its reset");
      }),
    );
  });

  describe("retry route", () => {
    const retry = createLibraryAutomationRetryRouteHandler;
    const userId = randomUUID();
    const config = (source: string) => ({ source, coverKey: "cover" });

    async function newItem(
      moduleId: "books" | "movies",
      properties: Record<string, unknown> = {},
      scope = tenantId,
      databaseId = moduleId === "books" ? library.booksId : library.moviesId,
    ): Promise<string> {
      const item = await runInTenant(scope, () =>
        createChokePoint(runtime).createItem({ databaseId, properties: { name: "Retry probe", ...properties } }),
      );
      return item.id;
    }

    async function newBlobId(scope = tenantId): Promise<string> {
      const blob = await runInTenant(scope, () =>
        withTransaction(runtime, async (client) =>
          createBlob(client, {
            mimeType: "image/png",
            byteSize: 4,
            storageKey: await tenantBlobStorageKey(client, `blobs/${randomUUID()}`),
          }),
        ),
      );
      return blob.id;
    }

    const call = (id: string, scope = tenantId) =>
      runInTenant(scope, () => retry(runtime)({ params: { id }, identity: { user: { id: userId } } }));
    const automationOf = (itemId: string, scope = tenantId) =>
      runInTenant(scope, () => withTransaction(runtime, (client) => getItemAutomation(client, itemId)));
    const propertiesOf = async (databaseId: string, itemId: string, scope = tenantId) => {
      const item = await runInTenant(scope, () => createChokePoint(runtime).getItem(databaseId, itemId));
      if (!item) throw new Error(`item ${itemId} is missing`);
      return item;
    };
    async function queuedJobs(itemId: string): Promise<number> {
      const { rows } = await admin.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE task_identifier = $1 AND key = $2",
        [CORE_TASK_NAMES.LIBRARY_METADATA_PROCESS, `library-metadata:${itemId}`],
      );
      return rows[0]?.n ?? -1;
    }
    function recordInvalidations(): InvalidationEvent[] {
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      return events;
    }
    /** Runs the queued metadata job of `scope` with a fetcher that finds the title at `source` and a cover. */
    async function runQueuedJob(source: "openLibrary" | "tmdb", fill: Record<string, unknown>): Promise<void> {
      const registry = createActionRegistry();
      registry.set(LIBRARY_METADATA_TRIGGER_ACTION_ID, createLibraryMetadataTriggerAction(runtime));
      registry.set(LIBRARY_METADATA_RETRY_SWEEP_ACTION_ID, createLibraryMetadataRetrySweepAction(runtime));
      const fetcher: LibraryMetadataFetcher = async () => ({
        status: "found",
        source,
        ...fill,
        cover: { mimeType: "image/jpeg", bytes: JOB_BYTES },
      });
      await runOnce({
        pgPool: runtime,
        taskList: createCoreTaskList(
          runtime,
          registry,
          fetcher,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          new LocalFsBlobStorageWriter(storageRoot),
        ),
      });
    }

    describe.each([
      { moduleId: "books", source: "openLibrary", fill: { author: "Frank Herbert" } },
      { moduleId: "movies", source: "tmdb", fill: { year: 2021 } },
    ] as const)("$moduleId", ({ moduleId, source, fill }) => {
      const databaseOf = () => (moduleId === "books" ? library.booksId : library.moviesId);

      it("clears a chosen cover, answers 202, and the queued job ends with the source of the found title", async () => {
        const itemId = await newItem(moduleId);
        const blobId = await newBlobId();
        await runInTenant(tenantId, () =>
          createChokePoint(runtime).updateItem({
            databaseId: databaseOf(),
            itemId,
            propertiesPatch: { coverOverride: { blobId }, coverSource: "userPhoto" },
          }),
        );
        const sibling = await newItem(moduleId);
        await runInTenant(tenantId, () =>
          createChokePoint(runtime).updateItem({
            databaseId: databaseOf(),
            itemId: sibling,
            propertiesPatch: { coverRemoved: true },
          }),
        );

        const answer = await call(itemId);

        expect(answer).toEqual({ status: 202, body: { itemId, status: "pending" } });
        expect((await propertiesOf(databaseOf(), itemId)).properties).toMatchObject({
          coverOverride: null,
          coverSource: null,
        });
        expect(await automationOf(itemId)).toMatchObject({ status: "pending", source: null });
        expect(await queuedJobs(itemId)).toBe(1);
        // Another item of the same database keeps its own choice.
        expect((await propertiesOf(databaseOf(), sibling)).properties).toMatchObject({ coverRemoved: true });

        await runQueuedJob(source, fill);

        expect(await automationOf(itemId)).toMatchObject({ status: "done", source });
        const found = await propertiesOf(databaseOf(), itemId);
        expect(found.properties).toMatchObject({ coverOverride: null, coverSource: null, ...fill });
        expect(z.object({ blobId: z.uuid() }).safeParse(found.properties.cover).success).toBe(true);
      });

      it("clears a removed cover to false, so the next run shows the found one", async () => {
        const itemId = await newItem(moduleId);
        await runInTenant(tenantId, () =>
          createChokePoint(runtime).updateItem({
            databaseId: databaseOf(),
            itemId,
            propertiesPatch: { coverRemoved: true },
          }),
        );

        expect((await call(itemId)).status).toBe(202);

        expect((await propertiesOf(databaseOf(), itemId)).properties).toMatchObject({ coverRemoved: false });
      });

      it("unlocks a locked row and resets a recorded failure, and the queued job then runs", async () => {
        const itemId = await newItem(moduleId);
        await runInTenant(tenantId, () =>
          withTransaction(runtime, async (client) => {
            await ensureItemAutomation(client, itemId);
            await markItemAutomationError(client, itemId, "failed", "providerFailed", source);
            await setItemAutomationLocked(client, itemId, true);
          }),
        );
        expect((await automationOf(itemId))?.status).toBe("locked");

        expect((await call(itemId)).status).toBe(202);

        expect(await automationOf(itemId)).toMatchObject({
          status: "pending",
          error: null,
          errorCode: null,
          source: null,
        });
        await runQueuedJob(source, fill);
        expect(await automationOf(itemId)).toMatchObject({ status: "done", source });
      });

      it("writes no property of an item that holds no manual choice, still creates the row and one job, and queues one job on a repeat", async () => {
        const itemId = await newItem(moduleId);
        const before = await propertiesOf(databaseOf(), itemId);
        expect(await automationOf(itemId)).toBeNull();

        expect((await call(itemId)).status).toBe(202);
        expect((await call(itemId)).status).toBe(202);

        const after = await propertiesOf(databaseOf(), itemId);
        expect(after.updatedAt).toBe(before.updatedAt);
        expect(after.properties).toEqual(before.properties);
        expect(await automationOf(itemId)).toMatchObject({ status: "pending" });
        expect(await queuedJobs(itemId)).toBe(1);
      });

      it("publishes the item's invalidation after the commit, for a status change without a property write too", async () => {
        const plain = await newItem(moduleId);
        const chosen = await newItem(moduleId);
        await runInTenant(tenantId, () =>
          createChokePoint(runtime).updateItem({
            databaseId: databaseOf(),
            itemId: chosen,
            propertiesPatch: { coverRemoved: true },
          }),
        );
        const events = recordInvalidations();

        await call(plain);
        const plainItem = await propertiesOf(databaseOf(), plain);
        expect(events).toEqual([
          {
            scope: "item",
            databaseId: databaseOf(),
            itemId: plain,
            op: "update",
            updatedAt: plainItem.updatedAt,
            userId,
          },
        ]);

        events.length = 0;
        await call(chosen);
        const chosenItem = await propertiesOf(databaseOf(), chosen);
        expect(events.length).toBeGreaterThanOrEqual(1);
        expect(events.every((event) => event.scope === "item" && event.itemId === chosen)).toBe(true);
        expect(events.at(-1)).toMatchObject({ op: "update", updatedAt: chosenItem.updatedAt, userId });
      });

      it("rolls the whole request back when the job source is unsupported, publishing nothing", async () => {
        const itemId = await newItem(moduleId);
        const blobId = await newBlobId();
        await runInTenant(tenantId, () =>
          createChokePoint(runtime).updateItem({
            databaseId: databaseOf(),
            itemId,
            propertiesPatch: { coverOverride: { blobId }, coverSource: "userImage" },
          }),
        );
        // Fixture SQL: a heartbeat config that no deployed build writes.
        await runInTenant(tenantId, () =>
          runtime.query(
            `UPDATE project_heartbeats SET action_config = action_config || $2::jsonb
             WHERE action_id = $1 AND action_config->>'databaseId' = $3`,
            [LIBRARY_METADATA_TRIGGER_ACTION_ID, JSON.stringify(config("bogus")), databaseOf()],
          ),
        );
        const before = await propertiesOf(databaseOf(), itemId);
        const events = recordInvalidations();

        await expect(call(itemId)).rejects.toBeInstanceOf(LibraryMetadataConfigurationError);

        expect((await propertiesOf(databaseOf(), itemId)).properties).toEqual(before.properties);
        expect(await automationOf(itemId)).toBeNull();
        expect(await queuedJobs(itemId)).toBe(0);
        expect(events).toEqual([]);
      });

      it("fails without a write when the database has no metadata heartbeat", async () => {
        const itemId = await newItem(moduleId);
        // Fixture SQL: a tenant whose seeded heartbeats were removed.
        await runInTenant(tenantId, () =>
          runtime.query("DELETE FROM project_heartbeats WHERE action_config->>'databaseId' = $1", [databaseOf()]),
        );
        const events = recordInvalidations();

        await expect(call(itemId)).rejects.toThrow("no metadata heartbeat");

        expect(await automationOf(itemId)).toBeNull();
        expect(await queuedJobs(itemId)).toBe(0);
        expect(events).toEqual([]);
      });

      it("fails without a write when the database has no owning project to read the job config from", async () => {
        const itemId = await newItem(moduleId);
        // Fixture SQL: no production path detaches a system database from its project.
        await runInTenant(tenantId, () =>
          runtime.query("UPDATE databases SET owner_project_item_id = NULL WHERE id = $1", [databaseOf()]),
        );

        await expect(call(itemId)).rejects.toThrow("no metadata heartbeat");

        expect(await automationOf(itemId)).toBeNull();
        expect(await queuedJobs(itemId)).toBe(0);
      });
    });

    describe("refusals", () => {
      async function expectUntouched(itemId: string, scope: string, events: InvalidationEvent[]): Promise<void> {
        expect(await automationOf(itemId, scope)).toBeNull();
        expect(await queuedJobs(itemId)).toBe(0);
        expect(events).toEqual([]);
      }

      it("answers 404 for an item of another tenant exactly like an unknown id, and changes nothing of it", async () => {
        const other = await createTestTenant(admin);
        const otherLibrary = await seedTenantLibrary(other);
        const foreign = await newItem("books", {}, other, otherLibrary.booksId);
        const blobId = await newBlobId(other);
        await runInTenant(other, () =>
          createChokePoint(runtime).updateItem({
            databaseId: otherLibrary.booksId,
            itemId: foreign,
            propertiesPatch: { coverOverride: { blobId }, coverSource: "userPhoto" },
          }),
        );
        const before = await propertiesOf(otherLibrary.booksId, foreign, other);
        const events = recordInvalidations();

        const foreignError = await call(foreign).catch((e: unknown) => e);
        const unknownError = await call(randomUUID()).catch((e: unknown) => e);

        expect(foreignError).toBeInstanceOf(NotFoundError);
        expect(foreignError).toMatchObject({ status: 404, code: "not_found", message: "Item not found" });
        expect(unknownError).toMatchObject({ status: 404, code: "not_found", message: "Item not found" });
        expect(await propertiesOf(otherLibrary.booksId, foreign, other)).toEqual(before);
        await expectUntouched(foreign, other, events);
        // The tenant that owns the item can retry it, so the 404 above was the tenant boundary.
        expect((await call(foreign, other)).status).toBe(202);
      });

      it("answers 404 for an item outside the library databases, and for a trashed library item", async () => {
        const task = await runInTenant(tenantId, async () => {
          const { rows } = await runtime.query<{ id: string }>(
            "SELECT id FROM databases WHERE owner_module_id = 'tasks'",
          );
          const databaseId = rows[0]?.id;
          if (!databaseId) throw new Error("Tasks is missing");
          return (await createChokePoint(runtime).createItem({ databaseId, properties: { name: "Not a book" } })).id;
        });
        const trashed = await newItem("movies");
        await runInTenant(tenantId, () => createChokePoint(runtime).softDeleteItem(library.moviesId, trashed));
        const events = recordInvalidations();

        for (const id of [task, trashed]) {
          await expect(call(id)).rejects.toMatchObject({ status: 404, message: "Item not found" });
          await expectUntouched(id, tenantId, events);
        }
      });

      it("answers 404 for a trashed item before it takes any lock, so the purge of that item cannot deadlock with it", async () => {
        const trashed = await newItem("books");
        await runInTenant(tenantId, async () => {
          await createChokePoint(runtime).softDeleteItem(library.booksId, trashed);
          await withTransaction(runtime, (client) => ensureItemAutomation(client, trashed));
        });
        const events = recordInvalidations();
        // The purge transaction of a trashed item: it holds the item row and deletes the automation row next.
        const purge = await admin.connect();
        let timer: NodeJS.Timeout | undefined;
        try {
          await purge.query("BEGIN");
          await purge.query("SELECT id FROM items WHERE id = $1 FOR UPDATE", [trashed]);
          const retried = call(trashed).catch((e: unknown) => e);
          const outcome = await Promise.race([
            retried,
            new Promise<string>((resolve) => {
              timer = setTimeout(() => resolve("blocked on a lock"), 4000);
            }),
          ]);
          expect(outcome).toMatchObject({ status: 404, message: "Item not found" });
          await purge.query("SET LOCAL lock_timeout = '2s'");
          await purge.query("DELETE FROM item_automation WHERE item_id = $1", [trashed]);
          await purge.query("COMMIT");
        } finally {
          clearTimeout(timer);
          await purge.query("ROLLBACK").catch(() => undefined);
          purge.release();
        }
        expect(await queuedJobs(trashed)).toBe(0);
        expect(await automationOf(trashed)).toBeNull();
        expect(events).toEqual([]);
      });

      it("answers 400 on id for an id that is not a UUID", async () => {
        const events = recordInvalidations();
        const error = await call("not-a-uuid").catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toMatchObject({ status: 400, details: { field: "id" } });
        expect(events).toEqual([]);
      });
    });
  });
});
