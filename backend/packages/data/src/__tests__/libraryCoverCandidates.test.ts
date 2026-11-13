import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import "../domainWriteHooks.js";
import { createBlob, tenantBlobStorageKey } from "../blobs/blobsStore.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import { ConflictError, NotFoundError, UpstreamUnavailableError, ValidationError } from "../errors.js";
import { ensureItemAutomation, getItemAutomation, setItemAutomationLocked } from "../library/itemAutomationStore.js";
import {
  getCoverCandidate,
  listCoverCandidates,
  replaceCoverCandidates,
  type CoverCandidateInput,
} from "../library/coverCandidatesStore.js";
import {
  createLibraryCoverCandidateSelectHandler,
  createLibraryCoverCandidatesListRouteHandler,
  createLibraryCoverCandidatesRefreshRouteHandler,
  createLibraryCoverCandidateSelectRouteHandler,
} from "../library/libraryCoverCandidateRouteHandlers.js";
import {
  createLibraryMetadataRetrySweepAction,
  createLibraryMetadataTriggerAction,
  LIBRARY_METADATA_RETRY_SWEEP_ACTION_ID,
  LIBRARY_METADATA_TRIGGER_ACTION_ID,
} from "../library/libraryMetadataActions.js";
import {
  handleProcessLibraryMetadataTask,
  type LibraryMetadataFetcher,
  type LibraryMetadataFetchResult,
} from "../library/libraryMetadataJob.js";
import {
  downloadLibraryCoverOutcome,
  type LibraryCoverDownload,
  type LibraryCoverDownloadOutcome,
} from "../library/openLibraryFetcher.js";
import { LocalFsBlobStorageWriter, type BlobStorageWriter } from "../mail/blobStorage.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import { createActionRegistry } from "../scheduler/actions.js";
import { seedSystem } from "../seed/seedSystem.js";
import { purgeExpiredTrash } from "../trash/purgeExpiredTrash.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  stubDnsLookup,
} from "../testSupport/testDb.js";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import { createCoreTaskList } from "../worker.js";

const IMAGE_BYTES = Uint8Array.from([0xff, 0xd8, 0x01, 0xff, 0xd9]);
const JOB_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);

let admin: Pool;
let runtime: Pool;
let tenantId: string;
let storageRoot: string;

interface SeededLibrary {
  booksId: string;
  moviesId: string;
}
let library: SeededLibrary;

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

const candidate = (n: number, overrides: Partial<CoverCandidateInput> = {}): CoverCandidateInput => ({
  source: "openLibrary",
  title: `Title ${n}`,
  subtitle: `Author ${n}, ${2000 + n}`,
  imageUrl: `https://covers.example.test/${n}.jpg`,
  ...overrides,
});

async function newItem(
  moduleId: "books" | "movies" = "books",
  scope = tenantId,
  databaseId = moduleId === "books" ? library.booksId : library.moviesId,
): Promise<string> {
  const item = await runInTenant(scope, () =>
    createChokePoint(runtime).createItem({ databaseId, properties: { name: "Probe" } }),
  );
  return item.id;
}

const storeCandidates = (itemId: string, candidates: readonly CoverCandidateInput[], scope = tenantId) =>
  runInTenant(scope, () => withTransaction(runtime, (client) => replaceCoverCandidates(client, itemId, candidates)));

const storedCandidates = (itemId: string, scope = tenantId) =>
  runInTenant(scope, () => withTransaction(runtime, (client) => listCoverCandidates(client, itemId)));

const itemOf = async (databaseId: string, itemId: string, scope = tenantId) => {
  const item = await runInTenant(scope, () => createChokePoint(runtime).getItem(databaseId, itemId));
  if (!item) throw new Error(`item ${itemId} is missing`);
  return item;
};

const automationOf = (itemId: string, scope = tenantId) =>
  runInTenant(scope, () => withTransaction(runtime, (client) => getItemAutomation(client, itemId)));

async function blobCount(scope = tenantId): Promise<number> {
  const { rows } = await runInTenant(scope, () => runtime.query<{ n: number }>("SELECT count(*)::int AS n FROM blobs"));
  return rows[0]?.n ?? -1;
}

async function queuedJobs(itemId: string): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE task_identifier = $1 AND key = $2",
    [CORE_TASK_NAMES.LIBRARY_METADATA_PROCESS, `library-metadata:${itemId}`],
  );
  return rows[0]?.n ?? -1;
}

/** Every file under the blob root, as paths relative to it. */
async function storedFiles(): Promise<string[]> {
  const entries = await readdir(storageRoot, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

function recordInvalidations(): InvalidationEvent[] {
  const events: InvalidationEvent[] = [];
  setInvalidationHook((event) => events.push(event));
  return events;
}

/** Runs the metadata job once for an item that already has an automation row, with a fetcher that returns `result`. */
async function runJob(
  itemId: string,
  moduleId: "books" | "movies",
  result: LibraryMetadataFetchResult,
  source: string = moduleId === "books" ? "openLibrary" : "tmdb",
  scope = tenantId,
): Promise<void> {
  const databaseId = moduleId === "books" ? library.booksId : library.moviesId;
  const fetcher: LibraryMetadataFetcher = async () => result;
  await runInTenant(scope, async () => {
    await withTransaction(runtime, (client) => ensureItemAutomation(client, itemId));
    await handleProcessLibraryMetadataTask(
      runtime,
      { itemId, databaseId, config: { source, coverKey: "cover" } },
      fetcher,
      undefined,
      new LocalFsBlobStorageWriter(storageRoot),
    );
  });
}

describe("library cover candidates (issue gh-1812)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenantId = await createTestTenant(admin);
    library = await seedTenantLibrary(tenantId);
    storageRoot = await mkdtemp(join(tmpdir(), "semprec-cover-candidates-"));
  });

  afterEach(async () => {
    setInvalidationHook(() => {});
    vi.restoreAllMocks();
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

  describe("store", () => {
    it("stores at most three candidates in order and replaces the earlier set", async () => {
      const itemId = await newItem();
      const sibling = await newItem();
      await storeCandidates(sibling, [candidate(9)]);

      expect(await storeCandidates(itemId, [candidate(1), candidate(2), candidate(3), candidate(4)])).toBe(3);
      expect(await storedCandidates(itemId)).toEqual([
        {
          index: 0,
          source: "openLibrary",
          title: "Title 1",
          subtitle: "Author 1, 2001",
          imageUrl: candidate(1).imageUrl,
        },
        {
          index: 1,
          source: "openLibrary",
          title: "Title 2",
          subtitle: "Author 2, 2002",
          imageUrl: candidate(2).imageUrl,
        },
        {
          index: 2,
          source: "openLibrary",
          title: "Title 3",
          subtitle: "Author 3, 2003",
          imageUrl: candidate(3).imageUrl,
        },
      ]);

      expect(await storeCandidates(itemId, [candidate(5, { source: "googleBooks", subtitle: null })])).toBe(1);
      expect(await storedCandidates(itemId)).toEqual([
        { index: 0, source: "googleBooks", title: "Title 5", subtitle: null, imageUrl: candidate(5).imageUrl },
      ]);
      expect(await storedCandidates(sibling)).toHaveLength(1);

      expect(await storeCandidates(itemId, [])).toBe(0);
      expect(await storedCandidates(itemId)).toEqual([]);
      expect(await storedCandidates(sibling)).toHaveLength(1);
    });

    it.each([
      ["http", "http://covers.example.test/a.jpg"],
      ["userinfo", "https://user:secret@covers.example.test/a.jpg"],
      ["port", "https://covers.example.test:8443/a.jpg"],
      ["IPv4 literal", "https://169.254.169.254/a.jpg"],
      ["IPv6 literal", "https://[fe80::1]/a.jpg"],
      ["localhost", "https://localhost/a.jpg"],
      ["unparseable", "not a url"],
    ])("drops an entry whose image URL is %s and numbers the kept ones from 0", async (_name, imageUrl) => {
      const itemId = await newItem();

      expect(await storeCandidates(itemId, [candidate(1, { imageUrl }), candidate(2), candidate(3)])).toBe(2);

      expect((await storedCandidates(itemId)).map((stored) => [stored.index, stored.imageUrl])).toEqual([
        [0, candidate(2).imageUrl],
        [1, candidate(3).imageUrl],
      ]);
    });

    it("looks up one candidate by position and reports a position with none", async () => {
      const itemId = await newItem();
      await storeCandidates(itemId, [candidate(1), candidate(2)]);
      const read = (index: number) =>
        runInTenant(tenantId, () => withTransaction(runtime, (client) => getCoverCandidate(client, itemId, index)));

      expect(await read(1)).toMatchObject({ index: 1, title: "Title 2" });
      expect(await read(2)).toBeNull();
    });

    it("refuses a row whose source this build does not know when it reads the set", async () => {
      const itemId = await newItem();
      await storeCandidates(itemId, [candidate(1)]);
      // Fixture SQL: a source value that no deployed build writes.
      await runInTenant(tenantId, () => runtime.query("UPDATE library_cover_candidates SET source = 'bogus'"));

      await expect(storedCandidates(itemId)).rejects.toThrow("Unknown cover candidate source");
    });

    it("refuses a position beyond 2 and a row of another tenant's scope", async () => {
      const itemId = await newItem();
      await expect(
        runInTenant(tenantId, () =>
          runtime.query(
            "INSERT INTO library_cover_candidates (item_id, idx, source, image_url) VALUES ($1, 3, 'tmdb', 'https://a.test/x')",
            [itemId],
          ),
        ),
      ).rejects.toThrow(/library_cover_candidates_idx_check/);

      const other = await createTestTenant(admin);
      await expect(
        runInTenant(other, () =>
          runtime.query(
            `INSERT INTO library_cover_candidates (item_id, idx, tenant_id, source, image_url)
             VALUES ($1, 0, $2, 'tmdb', 'https://a.test/x')`,
            [itemId, tenantId],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });

  describe("metadata job", () => {
    it("stores up to three candidates of a run with their source and replaces them on the next run", async () => {
      const itemId = await newItem();
      await runJob(itemId, "books", {
        status: "found",
        source: "openLibrary",
        candidates: [
          { title: "One", author: "A. Writer", year: 1999, coverUrl: "https://covers.example.test/1.jpg" },
          { title: "Two", year: 2001, coverUrl: "https://covers.example.test/2.jpg" },
          { title: "Three", coverUrl: "https://covers.example.test/3.jpg" },
          { title: "Four", coverUrl: "https://covers.example.test/4.jpg" },
        ],
      });

      expect(await storedCandidates(itemId)).toEqual([
        {
          index: 0,
          source: "openLibrary",
          title: "One",
          subtitle: "A. Writer, 1999",
          imageUrl: "https://covers.example.test/1.jpg",
        },
        {
          index: 1,
          source: "openLibrary",
          title: "Two",
          subtitle: "2001",
          imageUrl: "https://covers.example.test/2.jpg",
        },
        {
          index: 2,
          source: "openLibrary",
          title: "Three",
          subtitle: null,
          imageUrl: "https://covers.example.test/3.jpg",
        },
      ]);

      await runJob(itemId, "books", {
        status: "found",
        source: "googleBooks",
        candidates: [{ title: "Newer", author: "B. Writer", coverUrl: "https://covers.example.test/n.jpg" }],
      });

      expect(await storedCandidates(itemId)).toEqual([
        {
          index: 0,
          source: "googleBooks",
          title: "Newer",
          subtitle: "B. Writer",
          imageUrl: "https://covers.example.test/n.jpg",
        },
      ]);
      expect(await automationOf(itemId)).toMatchObject({ status: "done", source: "googleBooks" });
    });

    it("drops an entry without a cover URL or with an unsafe one, and uses the configured source when the result names none", async () => {
      const itemId = await newItem("movies");
      await runJob(itemId, "movies", {
        status: "found",
        candidates: [
          { title: "No cover" },
          { title: "Private", coverUrl: "https://10.0.0.1/c.jpg" },
          { title: "Kept", year: 2020, coverUrl: "https://image.example.test/k.jpg" },
        ],
      });

      expect(await storedCandidates(itemId)).toEqual([
        { index: 0, source: "tmdb", title: "Kept", subtitle: "2020", imageUrl: "https://image.example.test/k.jpg" },
      ]);
    });

    it("stores nothing when neither the result nor the configuration names a supported source", async () => {
      const itemId = await newItem();

      await runJob(
        itemId,
        "books",
        { candidates: [{ title: "Orphan", coverUrl: "https://covers.example.test/o.jpg" }] },
        "none",
      );

      expect(await storedCandidates(itemId)).toEqual([]);
    });

    it("clears the set on a run that finds nothing and keeps it on a run that fails", async () => {
      const itemId = await newItem();
      await storeCandidates(itemId, [candidate(1), candidate(2)]);

      await expect(runJob(itemId, "books", { status: "error", errorCode: "sourceUnavailable" })).rejects.toThrow(
        "Library metadata processing failed",
      );
      expect(await storedCandidates(itemId)).toHaveLength(2);
      expect(await automationOf(itemId)).toMatchObject({ status: "error" });

      await runJob(itemId, "books", { status: "notFound", source: "openLibrary" });
      expect(await storedCandidates(itemId)).toEqual([]);
      expect(await automationOf(itemId)).toMatchObject({ status: "notFound" });
    });

    it("keeps the set when the automation row is locked, and replaces only the run's own item", async () => {
      const locked = await newItem();
      const other = await newItem();
      await storeCandidates(locked, [candidate(1)]);
      await storeCandidates(other, [candidate(2)]);
      await runInTenant(tenantId, () =>
        withTransaction(runtime, async (client) => {
          await ensureItemAutomation(client, locked);
          await setItemAutomationLocked(client, locked, true);
        }),
      );

      await runJob(locked, "books", {
        status: "found",
        source: "openLibrary",
        candidates: [{ title: "Ignored", coverUrl: "https://covers.example.test/i.jpg" }],
      });
      expect(await storedCandidates(locked)).toHaveLength(1);
      expect((await storedCandidates(locked))[0]?.title).toBe("Title 1");

      await runJob(other, "books", { status: "found", source: "openLibrary", candidates: [] });
      expect(await storedCandidates(other)).toEqual([]);
      expect(await storedCandidates(locked)).toHaveLength(1);
    });
  });

  describe("list route", () => {
    const list = (id: string, scope = tenantId) =>
      runInTenant(scope, () =>
        createLibraryCoverCandidatesListRouteHandler(runtime)({
          params: { id },
          identity: { user: { id: randomUUID() } },
        }),
      );

    it("returns the stored candidates in order and makes no outbound request", async () => {
      const itemId = await newItem();
      await storeCandidates(itemId, [candidate(1), candidate(2, { source: "googleBooks", subtitle: null })]);
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const dns = stubDnsLookup({ "covers.example.test": ["93.184.216.34"] });
      try {
        const answer = await list(itemId);

        expect(answer).toEqual({
          status: 200,
          body: [
            {
              index: 0,
              source: "openLibrary",
              title: "Title 1",
              subtitle: "Author 1, 2001",
              imageUrl: candidate(1).imageUrl,
            },
            { index: 1, source: "googleBooks", title: "Title 2", subtitle: null, imageUrl: candidate(2).imageUrl },
          ],
        });
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(dns.calls).toEqual([]);
      } finally {
        dns.restore();
      }
    });

    it("returns an empty list for an item without candidates", async () => {
      expect(await list(await newItem("movies"))).toEqual({ status: 200, body: [] });
    });

    it("answers 404 for an item of another tenant exactly like an unknown id, and never lists its candidates", async () => {
      const other = await createTestTenant(admin);
      const otherLibrary = await seedTenantLibrary(other);
      const foreign = await newItem("books", other, otherLibrary.booksId);
      await storeCandidates(foreign, [candidate(1)], other);

      const foreignError = await list(foreign).catch((e: unknown) => e);
      const unknownError = await list(randomUUID()).catch((e: unknown) => e);

      expect(foreignError).toBeInstanceOf(NotFoundError);
      expect(foreignError).toMatchObject({ status: 404, code: "not_found", message: "Item not found" });
      expect(unknownError).toMatchObject({ status: 404, code: "not_found", message: "Item not found" });
      // The tenant that owns the item reads them, so the 404 above was the tenant boundary.
      expect((await list(foreign, other)).body).toHaveLength(1);
      // The own tenant's scope cannot see the foreign rows even by item id.
      expect(await storedCandidates(foreign)).toEqual([]);
    });

    it("answers 404 for an item outside the library databases and for a trashed library item", async () => {
      const task = await runInTenant(tenantId, async () => {
        const { rows } = await runtime.query<{ id: string }>(
          "SELECT id FROM databases WHERE owner_module_id = 'tasks'",
        );
        const databaseId = rows[0]?.id;
        if (!databaseId) throw new Error("Tasks is missing");
        return (await createChokePoint(runtime).createItem({ databaseId, properties: { name: "Not a book" } })).id;
      });
      const trashed = await newItem("movies");
      await storeCandidates(trashed, [candidate(1)]);
      await runInTenant(tenantId, () => createChokePoint(runtime).softDeleteItem(library.moviesId, trashed));

      for (const id of [task, trashed]) {
        await expect(list(id)).rejects.toMatchObject({ status: 404, message: "Item not found" });
      }
    });

    it("answers 400 on id for an id that is not a UUID", async () => {
      const error = await list("not-a-uuid").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ status: 400, details: { field: "id" } });
    });
  });

  describe("refresh route", () => {
    const userId = randomUUID();
    const refresh = (id: string, scope = tenantId) =>
      runInTenant(scope, () =>
        createLibraryCoverCandidatesRefreshRouteHandler(runtime)({
          params: { id },
          identity: { user: { id: userId } },
        }),
      );

    async function newBlobId(): Promise<string> {
      const blob = await runInTenant(tenantId, () =>
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

    async function runQueuedJob(result: LibraryMetadataFetchResult): Promise<void> {
      const registry = createActionRegistry();
      registry.set(LIBRARY_METADATA_TRIGGER_ACTION_ID, createLibraryMetadataTriggerAction(runtime));
      registry.set(LIBRARY_METADATA_RETRY_SWEEP_ACTION_ID, createLibraryMetadataRetrySweepAction(runtime));
      await runOnce({
        pgPool: runtime,
        taskList: createCoreTaskList(
          runtime,
          registry,
          async () => result,
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

    it("answers 202, enqueues the metadata job and keeps the chosen cover, and the job then replaces the candidates", async () => {
      const itemId = await newItem();
      const blobId = await newBlobId();
      await runInTenant(tenantId, () =>
        createChokePoint(runtime).updateItem({
          databaseId: library.booksId,
          itemId,
          propertiesPatch: { coverOverride: { blobId }, coverSource: "userPhoto" },
        }),
      );
      await storeCandidates(itemId, [candidate(1), candidate(2)]);
      const before = await itemOf(library.booksId, itemId);

      const answer = await refresh(itemId);

      expect(answer).toEqual({ status: 202, body: { itemId, status: "pending" } });
      expect(await automationOf(itemId)).toMatchObject({ status: "pending" });
      expect(await queuedJobs(itemId)).toBe(1);
      const after = await itemOf(library.booksId, itemId);
      expect(after.properties).toEqual(before.properties);
      expect(after.properties).toMatchObject({ coverOverride: { blobId }, coverSource: "userPhoto" });
      // Nothing is fetched while the request runs: the old set is still stored.
      expect(await storedCandidates(itemId)).toHaveLength(2);

      await runQueuedJob({
        status: "found",
        source: "openLibrary",
        cover: { mimeType: "image/jpeg", bytes: JOB_BYTES },
        candidates: [{ title: "Fresh", coverUrl: "https://covers.example.test/fresh.jpg" }],
      });

      expect(await storedCandidates(itemId)).toEqual([
        {
          index: 0,
          source: "openLibrary",
          title: "Fresh",
          subtitle: null,
          imageUrl: "https://covers.example.test/fresh.jpg",
        },
      ]);
      expect((await itemOf(library.booksId, itemId)).properties).toMatchObject({
        coverOverride: { blobId },
        coverSource: "userPhoto",
      });
    });

    it("sets a locked automation row to pending, queues one job on a repeat and publishes the invalidation after the commit", async () => {
      const itemId = await newItem("movies");
      await runInTenant(tenantId, () =>
        withTransaction(runtime, async (client) => {
          await ensureItemAutomation(client, itemId);
          await setItemAutomationLocked(client, itemId, true);
        }),
      );
      const events = recordInvalidations();

      expect((await refresh(itemId)).status).toBe(202);
      expect((await refresh(itemId)).status).toBe(202);

      expect(await automationOf(itemId)).toMatchObject({ status: "pending" });
      expect(await queuedJobs(itemId)).toBe(1);
      const item = await itemOf(library.moviesId, itemId);
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({
        scope: "item",
        databaseId: library.moviesId,
        itemId,
        op: "update",
        updatedAt: item.updatedAt,
        userId,
      });
    });

    it("fails without a write or an invalidation when the database has no metadata heartbeat", async () => {
      const itemId = await newItem();
      // Fixture SQL: a tenant whose seeded heartbeats were removed.
      await runInTenant(tenantId, () =>
        runtime.query("DELETE FROM project_heartbeats WHERE action_config->>'databaseId' = $1", [library.booksId]),
      );
      const events = recordInvalidations();

      await expect(refresh(itemId)).rejects.toThrow("no metadata heartbeat");

      expect(await automationOf(itemId)).toBeNull();
      expect(await queuedJobs(itemId)).toBe(0);
      expect(events).toEqual([]);
    });

    it("answers 404 for another tenant's item like an unknown id, and enqueues nothing", async () => {
      const other = await createTestTenant(admin);
      const otherLibrary = await seedTenantLibrary(other);
      const foreign = await newItem("books", other, otherLibrary.booksId);
      const events = recordInvalidations();

      const foreignError = await refresh(foreign).catch((e: unknown) => e);
      const unknownError = await refresh(randomUUID()).catch((e: unknown) => e);

      expect(foreignError).toMatchObject({ status: 404, code: "not_found", message: "Item not found" });
      expect(unknownError).toMatchObject({ status: 404, code: "not_found", message: "Item not found" });
      expect(await automationOf(foreign, other)).toBeNull();
      expect(await queuedJobs(foreign)).toBe(0);
      expect(events).toEqual([]);
      // The tenant that owns the item can refresh it, so the 404 above was the tenant boundary.
      expect((await refresh(foreign, other)).status).toBe(202);
    });

    it("answers 404 for a trashed item before it takes a lock, and 400 on id for a malformed id", async () => {
      const trashed = await newItem();
      await runInTenant(tenantId, () => createChokePoint(runtime).softDeleteItem(library.booksId, trashed));

      await expect(refresh(trashed)).rejects.toMatchObject({ status: 404, message: "Item not found" });
      expect(await automationOf(trashed)).toBeNull();
      expect(await queuedJobs(trashed)).toBe(0);
      await expect(refresh("not-a-uuid")).rejects.toMatchObject({ status: 400, details: { field: "id" } });
    });
  });

  describe("select route", () => {
    const userId = randomUUID();

    /**
     * `downloadCover` is a download that yields the image or nothing (nothing is an unusable image);
     * `downloadOutcome` is one that says how it ended.
     */
    function select(
      id: string,
      index: string,
      options: {
        downloadCover?: LibraryCoverDownload;
        downloadOutcome?: (url: string) => Promise<LibraryCoverDownloadOutcome>;
        storage?: BlobStorageWriter;
      } = {},
      scope = tenantId,
    ) {
      const { downloadCover, downloadOutcome, storage } = options;
      const fromImage = downloadCover
        ? async (url: string): Promise<LibraryCoverDownloadOutcome> => {
            const cover = await downloadCover(url);
            return cover ? { kind: "downloaded", cover } : { kind: "unusable" };
          }
        : undefined;
      const outcome = downloadOutcome ?? fromImage;
      return runInTenant(scope, () =>
        createLibraryCoverCandidateSelectHandler(runtime, {
          storage: storage ?? new LocalFsBlobStorageWriter(storageRoot),
          ...(outcome ? { downloadCover: outcome } : {}),
        })({ params: { id, index }, identity: { user: { id: userId } } }),
      );
    }

    /** A download that returns different bytes per URL and records the URLs it was asked for. */
    function recordingDownload(): { download: LibraryCoverDownload; urls: string[] } {
      const urls: string[] = [];
      const download: LibraryCoverDownload = async (url) => {
        urls.push(url);
        return { bytes: Uint8Array.from([...IMAGE_BYTES, ...Buffer.from(url)]), mimeType: "image/jpeg" };
      };
      return { download, urls };
    }

    it.each(["books", "movies"] as const)(
      "makes candidate 1 of a %s item the manual cover, clears the removal and leaves it to a later job run",
      async (moduleId) => {
        const databaseId = moduleId === "books" ? library.booksId : library.moviesId;
        const itemId = await newItem(moduleId);
        await runInTenant(tenantId, () =>
          createChokePoint(runtime).updateItem({ databaseId, itemId, propertiesPatch: { coverRemoved: true } }),
        );
        await storeCandidates(itemId, [candidate(1), candidate(2), candidate(3)]);
        const { download, urls } = recordingDownload();
        const events = recordInvalidations();

        const answer = await select(itemId, "1", { downloadCover: download });

        expect(urls).toEqual([candidate(2).imageUrl]);
        const stored = await itemOf(databaseId, itemId);
        const reference = stored.properties.coverOverride;
        expect(reference).toEqual({ blobId: expect.any(String) });
        expect(stored.properties).toMatchObject({ coverSource: "candidate", coverRemoved: false });
        expect(answer).toEqual({
          status: 200,
          body: { itemId, coverOverride: reference, coverSource: "candidate" },
        });
        const files = await storedFiles();
        expect(files).toHaveLength(1);
        expect(await readFile(files[0]!)).toEqual(Buffer.from([...IMAGE_BYTES, ...Buffer.from(candidate(2).imageUrl)]));
        expect(events.at(-1)).toMatchObject({
          scope: "item",
          itemId,
          op: "update",
          updatedAt: stored.updatedAt,
          userId,
        });
        // The other candidates stay selectable.
        expect(await storedCandidates(itemId)).toHaveLength(3);

        await runJob(itemId, moduleId, {
          status: "found",
          cover: { mimeType: "image/jpeg", bytes: JOB_BYTES },
          candidates: [{ title: "Later", coverUrl: "https://covers.example.test/later.jpg" }],
        });

        const afterJob = await itemOf(databaseId, itemId);
        expect(afterJob.properties.coverOverride).toEqual(reference);
        expect(afterJob.properties.coverSource).toBe("candidate");
        expect(afterJob.properties.cover).toEqual({ blobId: expect.any(String) });
        expect(afterJob.properties.cover).not.toEqual(reference);
      },
    );

    it("does not write coverRemoved for an item that holds no removal", async () => {
      const itemId = await newItem();
      await storeCandidates(itemId, [candidate(1)]);

      await select(itemId, "0", { downloadCover: recordingDownload().download });

      const stored = await itemOf(library.booksId, itemId);
      expect(stored.properties).toMatchObject({ coverSource: "candidate" });
      expect(stored.properties.coverRemoved).toBeUndefined();
    });

    it("keeps one file for two items that choose identical bytes, removing the staged duplicate", async () => {
      const first = await newItem();
      const second = await newItem();
      await storeCandidates(first, [candidate(1)]);
      await storeCandidates(second, [candidate(1)]);
      const same: LibraryCoverDownload = async () => ({ bytes: IMAGE_BYTES, mimeType: "image/jpeg" });

      await select(first, "0", { downloadCover: same });
      await select(second, "0", { downloadCover: same });

      expect((await itemOf(library.booksId, second)).properties.coverOverride).toEqual(
        (await itemOf(library.booksId, first)).properties.coverOverride,
      );
      expect(await blobCount()).toBe(1);
      expect(await storedFiles()).toHaveLength(1);
    });

    it.each(["169.254.169.254", "10.0.0.1"])(
      "refuses a candidate image that resolves to %s and writes nothing",
      async (address) => {
        const itemId = await newItem();
        await storeCandidates(itemId, [candidate(1, { imageUrl: "https://private-cover.example.test/c.jpg" })]);
        const before = await itemOf(library.booksId, itemId);
        const blobsBefore = await blobCount();
        const events = recordInvalidations();
        const dns = stubDnsLookup({ "private-cover.example.test": [address] });
        try {
          const error = await select(itemId, "0").catch((e: unknown) => e);

          expect(error).toBeInstanceOf(ValidationError);
          expect(error).toMatchObject({ status: 400, details: { field: "index" } });
          expect(dns.calls).toContain("private-cover.example.test");
        } finally {
          dns.restore();
        }
        expect(await itemOf(library.booksId, itemId)).toEqual(before);
        expect(await blobCount()).toBe(blobsBefore);
        expect(await storedFiles()).toEqual([]);
        expect(events).toEqual([]);
      },
    );

    it("refuses and writes nothing when the download yields no image", async () => {
      const itemId = await newItem();
      await storeCandidates(itemId, [candidate(1)]);
      const before = await itemOf(library.booksId, itemId);

      await expect(select(itemId, "0", { downloadCover: async () => undefined })).rejects.toMatchObject({
        status: 400,
        details: { field: "index" },
      });

      expect(await itemOf(library.booksId, itemId)).toEqual(before);
      expect(await blobCount()).toBe(0);
      expect(await storedFiles()).toEqual([]);
    });

    it.each([{ kind: "unusable" }, { kind: "refused" }] as const)(
      "answers 400 on index for the download outcome %j and writes nothing",
      async (outcome) => {
        const itemId = await newItem();
        await storeCandidates(itemId, [candidate(1)]);
        const before = await itemOf(library.booksId, itemId);

        const error = await select(itemId, "0", { downloadOutcome: async () => outcome }).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toMatchObject({ status: 400, details: { field: "index" } });
        expect(await itemOf(library.booksId, itemId)).toEqual(before);
        expect(await blobCount()).toBe(0);
        expect(await storedFiles()).toEqual([]);
      },
    );

    it.each(["timeout", "network", "status"] as const)(
      "answers 502 upstream_unavailable, not a validation error, when the image host fails with %s, and writes nothing",
      async (reason) => {
        const itemId = await newItem();
        await storeCandidates(itemId, [candidate(1)]);
        const before = await itemOf(library.booksId, itemId);
        const events = recordInvalidations();

        const error = await select(itemId, "0", {
          downloadOutcome: async () => ({ kind: "unavailable", reason }),
        }).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(UpstreamUnavailableError);
        expect(error).not.toBeInstanceOf(ValidationError);
        expect(error).toMatchObject({ status: 502, code: "upstream_unavailable", details: { reason } });
        expect(await itemOf(library.booksId, itemId)).toEqual(before);
        expect(await blobCount()).toBe(0);
        expect(await storedFiles()).toEqual([]);
        expect(events).toEqual([]);
      },
    );

    it("keeps the staged bytes and the committed cover when the COMMIT acknowledgement fails", async () => {
      const itemId = await newItem();
      await storeCandidates(itemId, [candidate(1)]);
      const patched = new Set<PoolClient>();
      const wroteBlob = new Set<PoolClient>();
      let injected = false;
      const onAcquire = (client: PoolClient) => {
        if (patched.has(client)) return;
        patched.add(client);
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const query = client.query;
        Object.defineProperty(client, "query", {
          configurable: true,
          writable: true,
          value: (...args: unknown[]) => {
            const result: unknown = Reflect.apply(query, client, args);
            const sql = typeof args[0] === "string" ? args[0] : "";
            // Only the select transaction touches `blobs`; the commit of a transaction that did not is let through.
            if (/\bblobs\b/.test(sql)) wroteBlob.add(client);
            if (sql !== "COMMIT" || injected || !wroteBlob.has(client)) return result;
            if (!(result instanceof Promise)) throw new Error("Expected asynchronous commit");
            // The server applied the commit; only its acknowledgement is lost.
            return result.then(() => {
              injected = true;
              throw new Error("commit acknowledgement failed");
            });
          },
        });
      };
      runtime.on("acquire", onAcquire);
      let error: unknown;
      try {
        error = await select(itemId, "0", { downloadCover: recordingDownload().download }).catch((e: unknown) => e);
      } finally {
        runtime.off("acquire", onAcquire);
        for (const client of patched) Reflect.deleteProperty(client, "query");
      }

      expect(injected).toBe(true);
      expect(error).toMatchObject({ message: "commit acknowledgement failed" });
      const stored = await itemOf(library.booksId, itemId);
      const reference = stored.properties.coverOverride as { blobId: string };
      expect(reference).toEqual({ blobId: expect.any(String) });
      const { rows } = await runInTenant(tenantId, () =>
        runtime.query<{ storage_key: string }>("SELECT storage_key FROM blobs WHERE id = $1", [reference.blobId]),
      );
      const files = await storedFiles();
      expect(files).toHaveLength(1);
      expect(files[0]).toContain(rows[0]!.storage_key);
      expect(await readFile(files[0]!)).toEqual(Buffer.from([...IMAGE_BYTES, ...Buffer.from(candidate(1).imageUrl)]));
    });

    it.each(["2", "3", "-1", "01", "x", ""])("answers 404 for the position %j without downloading", async (index) => {
      const itemId = await newItem();
      await storeCandidates(itemId, [candidate(1), candidate(2)]);
      const { download, urls } = recordingDownload();

      await expect(select(itemId, index, { downloadCover: download })).rejects.toMatchObject({
        status: 404,
        message: "Cover candidate not found",
      });

      expect(urls).toEqual([]);
      expect(await storedFiles()).toEqual([]);
    });

    it("answers 404 for another tenant's item like an unknown id, without downloading or changing it", async () => {
      const other = await createTestTenant(admin);
      const otherLibrary = await seedTenantLibrary(other);
      const foreign = await newItem("books", other, otherLibrary.booksId);
      await storeCandidates(foreign, [candidate(1)], other);
      const before = await itemOf(otherLibrary.booksId, foreign, other);
      const { download, urls } = recordingDownload();

      const foreignError = await select(foreign, "0", { downloadCover: download }).catch((e: unknown) => e);
      const unknownError = await select(randomUUID(), "0", { downloadCover: download }).catch((e: unknown) => e);

      expect(foreignError).toMatchObject({ status: 404, code: "not_found", message: "Item not found" });
      expect(unknownError).toMatchObject({ status: 404, code: "not_found", message: "Item not found" });
      expect(urls).toEqual([]);
      expect(await itemOf(otherLibrary.booksId, foreign, other)).toEqual(before);
      // The tenant that owns the item can select, so the 404 above was the tenant boundary.
      expect((await select(foreign, "0", { downloadCover: download }, other)).status).toBe(200);
    });

    it("answers 404 for an item outside the library databases and for a trashed one, and 400 on id for a malformed id", async () => {
      const task = await runInTenant(tenantId, async () => {
        const { rows } = await runtime.query<{ id: string }>(
          "SELECT id FROM databases WHERE owner_module_id = 'tasks'",
        );
        const databaseId = rows[0]?.id;
        if (!databaseId) throw new Error("Tasks is missing");
        return (await createChokePoint(runtime).createItem({ databaseId, properties: { name: "Not a book" } })).id;
      });
      await storeCandidates(task, [candidate(1)]);
      const trashed = await newItem();
      await storeCandidates(trashed, [candidate(1)]);
      await runInTenant(tenantId, () => createChokePoint(runtime).softDeleteItem(library.booksId, trashed));
      const { download, urls } = recordingDownload();

      for (const id of [task, trashed]) {
        await expect(select(id, "0", { downloadCover: download })).rejects.toMatchObject({
          status: 404,
          message: "Item not found",
        });
      }
      await expect(select("not-a-uuid", "0", { downloadCover: download })).rejects.toMatchObject({
        status: 400,
        details: { field: "id" },
      });
      expect(urls).toEqual([]);
    });

    it("answers 409 and removes the staged bytes when a run replaced the set while the image was downloading", async () => {
      const itemId = await newItem();
      await storeCandidates(itemId, [candidate(1)]);
      const before = await itemOf(library.booksId, itemId);
      const replacing: LibraryCoverDownload = async () => {
        await storeCandidates(itemId, [candidate(7)]);
        return { bytes: IMAGE_BYTES, mimeType: "image/jpeg" };
      };

      const error = await select(itemId, "0", { downloadCover: replacing }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictError);
      expect(error).toMatchObject({ status: 409, code: "cover_candidates_changed" });
      expect(await itemOf(library.booksId, itemId)).toEqual(before);
      expect(await blobCount()).toBe(0);
      expect(await storedFiles()).toEqual([]);
      expect((await storedCandidates(itemId))[0]?.imageUrl).toBe(candidate(7).imageUrl);
    });

    it("answers 409 when a run removed the set while the image was downloading", async () => {
      const itemId = await newItem();
      await storeCandidates(itemId, [candidate(1)]);
      const clearing: LibraryCoverDownload = async () => {
        await storeCandidates(itemId, []);
        return { bytes: IMAGE_BYTES, mimeType: "image/jpeg" };
      };

      await expect(select(itemId, "0", { downloadCover: clearing })).rejects.toMatchObject({
        status: 409,
        code: "cover_candidates_changed",
      });
      expect(await storedFiles()).toEqual([]);
    });

    it("answers 404 and removes the staged bytes when the item was trashed while the image was downloading", async () => {
      const itemId = await newItem();
      await storeCandidates(itemId, [candidate(1)]);
      const trashing: LibraryCoverDownload = async () => {
        await runInTenant(tenantId, () => createChokePoint(runtime).softDeleteItem(library.booksId, itemId));
        return { bytes: IMAGE_BYTES, mimeType: "image/jpeg" };
      };

      await expect(select(itemId, "0", { downloadCover: trashing })).rejects.toMatchObject({
        status: 404,
        message: "Item not found",
      });

      expect(await blobCount()).toBe(0);
      expect(await storedFiles()).toEqual([]);
    });

    it("rolls the write back and removes the staged bytes when the item update fails", async () => {
      const itemId = await newItem();
      await storeCandidates(itemId, [candidate(1)]);
      // Fixture SQL: a database whose cover property was removed, which the update then refuses.
      await runInTenant(tenantId, () =>
        runtime.query("DELETE FROM properties WHERE database_id = $1 AND key = 'coverSource'", [library.booksId]),
      );
      const events = recordInvalidations();

      await expect(select(itemId, "0", { downloadCover: recordingDownload().download })).rejects.toBeInstanceOf(
        ValidationError,
      );

      expect(await blobCount()).toBe(0);
      expect(await storedFiles()).toEqual([]);
      expect(events).toEqual([]);
    });

    it("reports the original failure when removing the staged bytes fails too", async () => {
      const itemId = await newItem();
      await storeCandidates(itemId, [candidate(1)]);
      const real = new LocalFsBlobStorageWriter(storageRoot);
      const failingDelete: BlobStorageWriter = {
        writeStream: (key, source, options) => real.writeStream(key, source, options),
        readStream: (key, range) => real.readStream(key, range),
        delete: () => Promise.reject(new Error("disk gone")),
      };
      const clearing: LibraryCoverDownload = async () => {
        await storeCandidates(itemId, []);
        return { bytes: IMAGE_BYTES, mimeType: "image/jpeg" };
      };

      await expect(select(itemId, "0", { downloadCover: clearing, storage: failingDelete })).rejects.toMatchObject({
        status: 409,
        code: "cover_candidates_changed",
      });
    });

    it("exports the factory the route table mounts, which builds a handler with the production download", async () => {
      const itemId = await newItem();
      await storeCandidates(itemId, [candidate(1, { imageUrl: "https://private-cover.example.test/c.jpg" })]);
      const dns = stubDnsLookup({ "private-cover.example.test": ["10.0.0.1"] });
      try {
        await expect(
          runInTenant(tenantId, () =>
            createLibraryCoverCandidateSelectRouteHandler(runtime)({
              params: { id: itemId, index: "0" },
              identity: { user: { id: userId } },
            }),
          ),
        ).rejects.toMatchObject({ status: 400, details: { field: "index" } });
        expect(dns.calls).toContain("private-cover.example.test");
      } finally {
        dns.restore();
      }
    });
  });

  describe("download outcome", () => {
    it.each(["http://covers.example.test/c.jpg", "https://10.0.0.1/c.jpg", "https://user:secret@example.test/c.jpg"])(
      "refuses %s without a request",
      async (url) => {
        expect(await downloadLibraryCoverOutcome(url)).toEqual({ kind: "refused" });
      },
    );

    it.each(["169.254.169.254", "10.0.0.1"])("refuses a host that resolves to %s", async (address) => {
      const dns = stubDnsLookup({ "private-cover.example.test": [address] });
      try {
        expect(await downloadLibraryCoverOutcome("https://private-cover.example.test/c.jpg")).toEqual({
          kind: "refused",
        });
      } finally {
        dns.restore();
      }
    });

    it("reports a host that does not resolve as unavailable, not as refused", async () => {
      const dns = stubDnsLookup({ "gone-cover.example.test": [] });
      try {
        expect(await downloadLibraryCoverOutcome("https://gone-cover.example.test/c.jpg")).toEqual({
          kind: "unavailable",
          reason: "network",
        });
      } finally {
        dns.restore();
      }
    });
  });

  describe("purge", () => {
    function fakeStorage(): BlobStorageWriter {
      return {
        writeStream: () => Promise.reject(new Error("not used by the purge")),
        readStream: () => {
          throw new Error("not used by the purge");
        },
        delete: async () => {},
      };
    }

    it("removes the candidates of a purged item and keeps those of another item", async () => {
      const purged = await newItem();
      const kept = await newItem();
      await storeCandidates(purged, [candidate(1), candidate(2)]);
      await storeCandidates(kept, [candidate(3)]);
      await runInTenant(tenantId, () => createChokePoint(runtime).softDeleteItem(library.booksId, purged));
      // Fixture SQL: the only way to age a trashed row past the 30 days retention.
      await admin.query("UPDATE items SET deleted_at = now() - interval '31 days' WHERE id = $1 AND database_id = $2", [
        purged,
        library.booksId,
      ]);
      // Trashing alone keeps the rows, so the item can be restored with its candidates.
      expect(await storedCandidates(purged)).toHaveLength(2);

      expect(await runInTenant(tenantId, () => purgeExpiredTrash(runtime, fakeStorage()))).toBe(1);

      expect(await storedCandidates(purged)).toEqual([]);
      expect(await storedCandidates(kept)).toHaveLength(1);
    });
  });
});
