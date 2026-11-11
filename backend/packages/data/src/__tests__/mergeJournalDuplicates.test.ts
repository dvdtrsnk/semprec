import "../domainWriteHooks.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { DatabaseError, type Pool, type PoolClient } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import { countJobsByIdentifier } from "@semprec/queue/testSupport";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import {
  registerItemDeleteHook,
  registerRelationEdgeChangedHook,
  registerRelationEdgeDeleteHook,
  registerRelationEdgeWriteHook,
} from "../chokePoint/hooks.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { moveRelationEdgesWithClient } from "../chokePoint/relationOps.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { withClient, withTransaction } from "../db/pool.js";
import { insertPageMarkdown, readPageMarkdown } from "../docs/pageMarkdown.js";
import { createSubpageWithClient } from "../docs/pageOperations.js";
import { CardinalityViolationError, ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { syncJournalEventLinks } from "../journal/journalEventLinks.js";
import { getOrCreateJournalItem, type JournalPeriodType } from "../journal/journalStore.js";
import { logger } from "../journal/logger.js";
import { mergeJournalDuplicates, type MergeJournalDuplicatesResult } from "../journal/mergeJournalDuplicates.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import { createActionRegistry } from "../scheduler/actions.js";
import { seedSystem } from "../seed/seedSystem.js";
import {
  createInboxItemWithClient,
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import { createApiCoreTaskList } from "../worker.js";

const DAY = "2026-10-16";
const REFERENCE = new Date("2026-10-16T12:00:00Z");
const ZONE = "Europe/Prague";
const WAIT_MS = 10_000;
const recomputeTask = CORE_TASK_NAMES.JOURNAL_INBOX_RECOMPUTE;

/** Orders ids as Postgres orders `uuid` values: by code unit, independent of the runtime's collation. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface DatabaseIds {
  journal: string;
  inbox: string;
  areas: string;
  projects: string;
  events: string;
  tasks: string;
}

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;
let tenant: string;
let ids: DatabaseIds;
let invalidations: InvalidationEvent[];
/** The Journal logger's `info`, replaced for each test: the merge writes one line per edge it left on the duplicate. */
let refusedEdgeLog: MockInstance<typeof logger.info>;
const REFUSED_EDGE_MESSAGE = "Journal duplicate merge left a refused edge on the merged entry";

// Fault injection through the choke point's hook registries, which have no unregister: the four hooks are registered
// once for this file and do nothing until a test arms one; `beforeEach` disarms them all.
/** The item delete hook rejects the trash of this item. */
let failTrashOf: string | null = null;
/** The edge-changed hook rejects the first edge created on this item. */
let failEdgeCreatedOn: string | null = null;
/** The edge write hook, which also runs when an edge is only checked, fails for an edge whose caller is this item. */
let failEdgeCheckOf: string | null = null;
/** The same hook refuses an edge whose caller is this item, as a domain rule does: a `ValidationError` without details. */
let refuseEdgeCheckOf: string | null = null;
/** The edge delete hook removes this edge on another connection, right before the caller's own delete of it runs. */
let removeConcurrently: { relationPropertyId: string; callerItemId: string; targetItemId: string } | null = null;

async function databaseIds(tenantId: string): Promise<DatabaseIds> {
  const { rows } = await runInTenant(tenantId, () =>
    pool.query<{ id: string; owner_module_id: string | null }>(
      "SELECT id, owner_module_id FROM databases WHERE system",
    ),
  );
  const idOf = (moduleId: string): string => {
    const id = rows.find((row) => row.owner_module_id === moduleId)?.id;
    if (id === undefined) throw new Error(`System database '${moduleId}' is not seeded`);
    return id;
  };
  return {
    journal: idOf("journal"),
    inbox: idOf("inbox"),
    areas: idOf("areas"),
    projects: idOf("projects"),
    events: idOf("events"),
    tasks: idOf("tasks"),
  };
}

/** The period's entry through the lazy create, which takes the period reservation for it. */
function reservedEntry(tenantId = tenant, databases = ids): Promise<string> {
  return runInTenant(tenantId, () =>
    withTransaction(
      pool,
      async (client) => (await getOrCreateJournalItem(client, databases.journal, "day", REFERENCE, ZONE)).id,
    ),
  );
}

/** One more live entry of a period, created on `client` through the choke point's create without the reservation. */
async function createUnreservedEntry(
  client: PoolClient,
  journalId: string,
  period: string,
  type: JournalPeriodType = "day",
): Promise<string> {
  const entry = await createItemWithClient(
    client,
    { databaseId: journalId, properties: { name: `\u{1F4D3} ${period}`, type, period } },
    { allowedSystemKeys: ["name", "type", "period"] },
  );
  return entry.id;
}

/**
 * A further live entry of a day. The lazy create never makes one while the period has a live entry: two live entries
 * are what earlier data left behind (restores before issue #1666), so the fixture creates the entry directly.
 */
function unreservedEntry(period = DAY, tenantId = tenant, databases = ids): Promise<string> {
  return runInTenant(tenantId, () =>
    withTransaction(pool, (client) => createUnreservedEntry(client, databases.journal, period)),
  );
}

/** Two live entries of `DAY`: `older` was created first, `newer` holds the period reservation and gets the captures. */
async function duplicatedDay(tenantId = tenant, databases = ids): Promise<{ older: string; newer: string }> {
  const older = await unreservedEntry(DAY, tenantId, databases);
  const newer = await reservedEntry(tenantId, databases);
  return { older, newer };
}

function merge(
  period = DAY,
  periodType: JournalPeriodType = "day",
  tenantId = tenant,
): Promise<MergeJournalDuplicatesResult | null> {
  return runInTenant(tenantId, () =>
    withTransaction(pool, (client) => mergeJournalDuplicates(client, { periodType, period })),
  );
}

/** Appends Markdown to an entry's page as the user, through the production insertion. */
async function write(itemId: string, markdown: string, tenantId = tenant): Promise<void> {
  await runInTenant(tenantId, () =>
    withTransaction(pool, (client) =>
      insertPageMarkdown(client, itemId, { placement: "end", markdown, origin: "user" }),
    ),
  );
}

async function page(itemId: string, tenantId = tenant): Promise<string> {
  return runInTenant(tenantId, () =>
    withTransaction(pool, async (client) => (await readPageMarkdown(client, itemId)).markdown),
  );
}

async function relationProperty(databaseId: string, key: string, tenantId = tenant) {
  return runInTenant(tenantId, () =>
    withTransaction(pool, async (client) => {
      const property = await propertiesStore.getPropertyByKey(client, databaseId, key);
      const definition = property ? await relationsStore.getRelationDefinitionByPropertyId(client, property.id) : null;
      if (!property || !definition) throw new Error(`Relation '${key}' is not seeded`);
      return { property, definition };
    }),
  );
}

/** Links a Journal entry to an item through one of the entry's user-owned relation properties, as a user write does. */
async function link(
  key: "area" | "project",
  entryId: string,
  targetItemId: string,
  metadata: Record<string, unknown> = {},
  tenantId = tenant,
  databases = ids,
): Promise<void> {
  const { property } = await relationProperty(databases.journal, key, tenantId);
  await runInTenant(tenantId, () =>
    cp.createRelation({ relationPropertyId: property.id, callerItemId: entryId, targetItemId, metadata }),
  );
}

/** The items `itemId` is linked to through the relation `key` of `databaseId`, with each edge's metadata, by item id. */
async function related(
  databaseId: string,
  key: string,
  itemId: string,
  tenantId = tenant,
): Promise<Array<{ item: string; metadata: Record<string, unknown> }>> {
  const { definition } = await relationProperty(databaseId, key, tenantId);
  return runInTenant(tenantId, () =>
    withTransaction(pool, async (client) => {
      const edges = await relationsStore.listRelationsForItem(client, definition.id, itemId);
      return edges
        .map((edge) => ({ item: relationsStore.otherSide(edge, itemId), metadata: edge.metadata }))
        .sort((a, b) => byCodeUnit(a.item, b.item));
    }),
  );
}

async function relatedIds(databaseId: string, key: string, itemId: string, tenantId = tenant): Promise<string[]> {
  return (await related(databaseId, key, itemId, tenantId)).map((edge) => edge.item);
}

function createNamed(databaseId: string, name: string, tenantId = tenant): Promise<string> {
  return runInTenant(tenantId, async () => (await cp.createItem({ databaseId, properties: { name } })).id);
}

/** Captures one Inbox item of `DAY` through the production Inbox writer; its create hook links it to the day's entry. */
function capture(text: string, tenantId = tenant, databases = ids): Promise<string> {
  return runInTenant(tenantId, () =>
    withTransaction(
      pool,
      async (client) =>
        (await createInboxItemWithClient(client, { inboxDatabaseId: databases.inbox, date: DAY, time: "09:00", text }))
          .id,
    ),
  );
}

/** The entries of a period, live and trashed, in id order. */
async function periodEntries(period = DAY, tenantId = tenant, databases = ids) {
  return runInTenant(tenantId, async () => {
    const { rows } = await pool.query<{ id: string; live: boolean }>(
      `SELECT id, deleted_at IS NULL AS live FROM items
       WHERE database_id = $1 AND properties->>'type' = 'day' AND properties->>'period' = $2 ORDER BY id`,
      [databases.journal, period],
    );
    return rows;
  });
}

function reservationKey(period = DAY, databases = ids): string {
  return `journal:${databases.journal}:day:${period}`;
}

/** The item the period's reservation points at, or null when there is none. */
async function reservation(period = DAY, tenantId = tenant, databases = ids): Promise<string | null> {
  return runInTenant(tenantId, async () => {
    const { rows } = await pool.query<{ item_id: string }>("SELECT item_id FROM idempotency_keys WHERE key = $1", [
      reservationKey(period, databases),
    ]);
    return rows[0]?.item_id ?? null;
  });
}

/** The queued jobs of every core task, counted over the whole queue. */
async function queued(): Promise<Record<string, number>> {
  const jobs: Record<string, number> = {};
  for (const task of Object.values(CORE_TASK_NAMES)) jobs[task] = await countJobsByIdentifier(admin, task);
  return jobs;
}

/** Everything a merge writes, as stored for one tenant. */
async function stored(tenantId = tenant) {
  return runInTenant(tenantId, async () => ({
    items: (
      await pool.query<{
        id: string;
        properties: unknown;
        computed: unknown;
        deleted_at: Date | null;
        updated_at: Date;
      }>("SELECT id, properties, computed, deleted_at, updated_at FROM items ORDER BY id")
    ).rows,
    relations: (
      await pool.query<{
        id: string;
        relation_definition_id: string;
        item_a: string;
        item_b: string;
        metadata: unknown;
      }>("SELECT id, relation_definition_id, item_a, item_b, metadata FROM item_relations ORDER BY id")
    ).rows,
    reservations: (
      await pool.query<{ key: string; database_id: string; item_id: string }>(
        "SELECT key, database_id, item_id FROM idempotency_keys ORDER BY key",
      )
    ).rows,
    docs: (
      await pool.query<{ id: string; item_id: string; last_edited_at: Date | null; last_edited_by: string | null }>(
        "SELECT id, item_id, last_edited_at, last_edited_by FROM docs ORDER BY id",
      )
    ).rows,
    docUpdates: (
      await pool.query<{ id: string; doc_id: string; created_by: string }>(
        "SELECT id, doc_id, created_by FROM doc_updates ORDER BY id",
      )
    ).rows,
  }));
}

/** `stored` of the test's tenant together with `queued`: what a merge that does nothing must leave equal. */
async function everything() {
  return { stored: await stored(), queued: await queued() };
}

/** Drains the queued Inbox recompute jobs with the production API task list. */
async function runRecomputeJobs(): Promise<void> {
  const handler = createApiCoreTaskList(pool, createActionRegistry())[recomputeTask];
  if (!handler) throw new Error("Journal Inbox recompute handler missing from production API task list");
  await runOnce({ pgPool: admin }, { [recomputeTask]: handler });
}

const cachedInboxItems = z.object({ inboxItems: z.array(z.object({ id: z.string() })) });

/** The ids in an entry's cached Inbox list (`computed.inboxItems`), sorted; the entry may be in the Trash. */
async function cachedInboxItemIds(itemId: string): Promise<string[]> {
  const { rows } = await runInTenant(tenant, () =>
    pool.query<{ computed: unknown }>("SELECT computed FROM items WHERE id = $1", [itemId]),
  );
  return cachedInboxItems
    .parse(rows[0]?.computed)
    .inboxItems.map((entry) => entry.id)
    .sort();
}

/** The error `work` rejects with; a `work` that fulfils fails the test. */
async function rejection(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => {
      throw new Error("Expected a rejection");
    },
    (error: unknown) => error,
  );
}

interface Gate {
  promise: Promise<void>;
  open: () => void;
}

function gate(): Gate {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function withinWait<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not happen within ${WAIT_MS} ms`)), WAIT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function backendPid(client: PoolClient): Promise<number> {
  const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  const pid = rows[0]?.pid;
  if (pid === undefined) throw new Error("No backend pid");
  return pid;
}

/** Polls (bounded) until `waiter`'s statement is blocked by `holder`, read through the admin pool; stops when aborted. */
async function untilBlocked(waiter: number, holder: number, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    if (signal.aborted) return;
    const { rows } = await admin.query<{ blocked: boolean }>(
      "SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked",
      [waiter, holder],
    );
    if (rows[0]?.blocked === true) return;
    if (Date.now() > deadline) throw new Error(`Backend ${waiter} was not blocked by ${holder}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Rejects as soon as `write` settles: a write that should still be waiting has finished, or it failed. */
function settledEarly(write: Promise<unknown>, label: string): Promise<never> {
  return write.then((): never => {
    throw new Error(`${label} finished before it was expected to`);
  });
}

/**
 * Runs `first` in a transaction that stays open until the second writer is observed waiting on it, then commits it
 * and settles both (the harness of `journal/__tests__/journalRestore.test.ts`). `whileWaiting` runs once the second
 * writer waits and before the first commits. The gate is opened on every path, and both transactions are awaited
 * before this returns, so a failing case leaves no open transaction behind.
 */
async function contended<A, B>(
  first: (client: PoolClient) => Promise<A>,
  second: (client: PoolClient) => Promise<B>,
  whileWaiting: () => Promise<void> = async () => undefined,
): Promise<[PromiseSettledResult<A>, PromiseSettledResult<B>]> {
  const release = gate();
  let firstPid: (pid: number) => void = () => undefined;
  const firstReady = new Promise<number>((resolve) => {
    firstPid = resolve;
  });
  let secondPid: (pid: number) => void = () => undefined;
  const secondStarted = new Promise<number>((resolve) => {
    secondPid = resolve;
  });
  const a = runInTenant(tenant, () =>
    withTransaction(pool, async (client) => {
      const result = await first(client);
      firstPid(await backendPid(client));
      await release.promise;
      return result;
    }),
  );
  let b: Promise<B> = Promise.reject(new Error("The second write was not started"));
  b.catch(() => undefined);
  const stopPolling = new AbortController();
  let polling: Promise<void> = Promise.resolve();
  let primary: unknown;
  try {
    const holder = await withinWait(Promise.race([firstReady, settledEarly(a, "The first write")]), "The first write");
    b = runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        secondPid(await backendPid(client));
        return second(client);
      }),
    );
    const waiter = await withinWait(
      Promise.race([secondStarted, settledEarly(b, "The second write")]),
      "The second write",
    );
    polling = untilBlocked(waiter, holder, stopPolling.signal);
    await Promise.race([polling, settledEarly(b, "The second write")]);
    await whileWaiting();
  } catch (error) {
    primary = error;
  } finally {
    stopPolling.abort();
    release.open();
  }
  await Promise.allSettled([polling]);
  const settled = await Promise.allSettled([a, b] as const);
  if (primary instanceof Error) throw primary;
  if (primary !== undefined) throw new Error("The contended writes failed with a non-Error value", { cause: primary });
  return settled;
}

describe("merging the duplicate Journal entries of one period (issue #1726)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);

    registerItemDeleteHook(async ({ item }) => {
      if (item.id === failTrashOf) throw new Error("injected trash failure");
    });
    registerRelationEdgeChangedHook(async (context) => {
      if (context.op !== "create" || failEdgeCreatedOn === null) return;
      if (context.itemA === failEdgeCreatedOn || context.itemB === failEdgeCreatedOn) {
        throw new Error("injected edge failure");
      }
    });
    registerRelationEdgeWriteHook(async (context) => {
      if (context.callerItemId === failEdgeCheckOf) throw new Error("injected check failure");
      if (context.callerItemId === refuseEdgeCheckOf) throw new ValidationError("injected refusal");
    });
    registerRelationEdgeDeleteHook(async (context) => {
      const edge = removeConcurrently;
      if (edge === null || context.callerItemId !== edge.callerItemId || context.targetItemId !== edge.targetItemId) {
        return;
      }
      removeConcurrently = null;
      const removed = await runInTenant(tenant, () => cp.deleteRelation(edge));
      if (!removed) throw new Error("The concurrent removal found no edge");
    });
  });

  beforeEach(async () => {
    failTrashOf = null;
    failEdgeCreatedOn = null;
    failEdgeCheckOf = null;
    refuseEdgeCheckOf = null;
    removeConcurrently = null;
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool));
    ids = await databaseIds(tenant);
    cp = createChokePoint(pool);
    invalidations = [];
    setInvalidationHook((event) => invalidations.push(event));
    refusedEdgeLog = vi.spyOn(logger, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    setInvalidationHook(() => {});
    refusedEdgeLog.mockRestore();
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  describe("two live entries of one day", () => {
    it("keeps the entry created first, with the content of both pages in block order, and trashes the other", async () => {
      const { older, newer } = await duplicatedDay();
      await write(older, "# Friday\n\nOlder note");
      await write(newer, "# Friday\n\nNewer note\n\n- first\n- second\n\n> quoted");

      expect(await merge()).toEqual({ survivorId: older, mergedItemId: newer, refusedEdges: [] });

      expect(await page(older)).toBe("# Friday\n\nOlder note\n\nNewer note\n\n- first\n- second\n\n> quoted");
      expect(await periodEntries()).toEqual(
        [
          { id: older, live: true },
          { id: newer, live: false },
        ].sort((x, y) => byCodeUnit(x.id, y.id)),
      );
      // The duplicate keeps its page, so the trashed entry can be restored whole.
      expect(await page(newer)).toBe("# Friday\n\nNewer note\n\n- first\n- second\n\n> quoted");
      const { rows: edits } = await runInTenant(tenant, () =>
        pool.query<{ created_by: string }>(
          `SELECT u.created_by FROM doc_updates u JOIN docs d ON d.id = u.doc_id WHERE d.item_id = $1 ORDER BY u.id`,
          [older],
        ),
      );
      expect(edits.map((edit) => edit.created_by)).toEqual(["user", "system"]);
    });

    it("keeps the entry created first also when that is the one the reservation points at", async () => {
      const reserved = await reservedEntry();
      const later = await unreservedEntry();
      await write(reserved, "First");
      await write(later, "Second");

      expect(await merge()).toEqual({ survivorId: reserved, mergedItemId: later, refusedEdges: [] });
      expect(await page(reserved)).toBe("First\n\nSecond");
      expect(await reservation()).toBe(reserved);
    });

    it("breaks a tie of two entries created in one transaction by id", async () => {
      const pair = await runInTenant(tenant, () =>
        withTransaction(pool, async (client) => [
          await createUnreservedEntry(client, ids.journal, DAY),
          await createUnreservedEntry(client, ids.journal, DAY),
        ]),
      );
      const { rows } = await runInTenant(tenant, () =>
        pool.query<{ created: number }>(
          "SELECT count(DISTINCT created_at)::int AS created FROM items WHERE id = ANY($1::uuid[])",
          [pair],
        ),
      );
      expect(rows[0]?.created).toBe(1);
      const [lower, higher] = [...pair].sort();
      expect(await reservation()).toBeNull();

      expect(await merge()).toEqual({ survivorId: lower, mergedItemId: higher, refusedEdges: [] });
      expect(await reservation()).toBe(lower);
    });

    it("moves the duplicate's project to the survivor", async () => {
      const { older, newer } = await duplicatedDay();
      const project = await createNamed(ids.projects, "Garden");
      await link("project", newer, project);

      await merge();

      expect(await relatedIds(ids.journal, "project", older)).toEqual([project]);
      expect(await relatedIds(ids.journal, "project", newer)).toEqual([]);
    });

    it("moves every area edge to the survivor and keeps an edge the survivor already has as it is", async () => {
      const { older, newer } = await duplicatedDay();
      const home = await createNamed(ids.areas, "Home");
      const work = await createNamed(ids.areas, "Work");
      await link("area", older, home, { from: "survivor" });
      await link("area", newer, home, { from: "duplicate" });
      await link("area", newer, work, { from: "duplicate" });

      expect(await merge()).toEqual({ survivorId: older, mergedItemId: newer, refusedEdges: [] });

      expect(await related(ids.journal, "area", older)).toEqual(
        [
          { item: home, metadata: { from: "survivor" } },
          { item: work, metadata: { from: "duplicate" } },
        ].sort((a, b) => byCodeUnit(a.item, b.item)),
      );
      expect(await relatedIds(ids.journal, "area", newer)).toEqual([]);
      expect(refusedEdgeLog).not.toHaveBeenCalled();
    });

    it("gives the survivor the event links of the duplicate's page through the events relation's owner", async () => {
      const { older, newer } = await duplicatedDay();
      const kept = await runInTenant(tenant, async () =>
        cp.createItem({ databaseId: ids.events, properties: { name: "Review", date: DAY } }),
      );
      const moved = await runInTenant(tenant, async () =>
        cp.createItem({ databaseId: ids.events, properties: { name: "Standup", date: DAY } }),
      );
      const olderText = `Notes from [Review](semprec://items/${kept.id})`;
      const newerText = `Notes from [Standup](semprec://items/${moved.id})`;
      await write(older, olderText);
      await write(newer, newerText);
      // The page-text job derives the system-owned `events` edges from the page; the fixture runs its owner directly.
      await runInTenant(tenant, () =>
        withTransaction(pool, async (client) => {
          await syncJournalEventLinks(client, older, olderText);
          await syncJournalEventLinks(client, newer, newerText);
        }),
      );
      expect(await relatedIds(ids.journal, "events", newer)).toEqual([moved.id]);

      await merge();

      expect(await relatedIds(ids.journal, "events", older)).toEqual([kept.id, moved.id].sort());
      expect(await relatedIds(ids.journal, "events", newer)).toEqual([moved.id]);
    });

    it("points the Inbox items of the duplicate day at the survivor and recomputes both cached Inbox lists", async () => {
      const { older, newer } = await duplicatedDay();
      const first = await capture("First note");
      const second = await capture("Second note");
      expect(await relatedIds(ids.inbox, "journalDay", first)).toEqual([newer]);
      await runRecomputeJobs();
      expect(await cachedInboxItemIds(newer)).toEqual([first, second].sort());

      expect(await merge()).toEqual({ survivorId: older, mergedItemId: newer, refusedEdges: [] });

      expect(await relatedIds(ids.inbox, "journalDay", first)).toEqual([older]);
      expect(await relatedIds(ids.inbox, "journalDay", second)).toEqual([older]);
      expect(refusedEdgeLog).not.toHaveBeenCalled();
      expect(await countJobsByIdentifier(admin, recomputeTask)).toBe(2);
      await runRecomputeJobs();
      expect(await cachedInboxItemIds(older)).toEqual([first, second].sort());
      expect(await cachedInboxItemIds(newer)).toEqual([]);
    });

    it("queues no Inbox recompute when the duplicate has no Inbox items", async () => {
      await duplicatedDay();

      await merge();

      expect(await countJobsByIdentifier(admin, recomputeTask)).toBe(0);
    });

    it("points the period reservation at the survivor, so the next write for the day returns it", async () => {
      const { older, newer } = await duplicatedDay();
      expect(await reservation()).toBe(newer);

      await merge();

      expect(await reservation()).toBe(older);
      expect(await reservedEntry()).toBe(older);
      expect(await periodEntries()).toHaveLength(2);
      const captured = await capture("After the merge");
      expect(await relatedIds(ids.inbox, "journalDay", captured)).toEqual([older]);
    });
  });

  describe("the duplicate's heading", () => {
    it.each([
      {
        name: "is removed when the survivor's page starts with the same heading",
        survivor: "# Friday\n\nOlder",
        duplicate: "# Friday\n\nNewer",
        merged: "# Friday\n\nOlder\n\nNewer",
      },
      {
        name: "is kept when its text differs",
        survivor: "# Friday\n\nOlder",
        duplicate: "# Saturday\n\nNewer",
        merged: "# Friday\n\nOlder\n\n# Saturday\n\nNewer",
      },
      {
        name: "is kept when its level differs",
        survivor: "# Friday\n\nOlder",
        duplicate: "## Friday\n\nNewer",
        merged: "# Friday\n\nOlder\n\n## Friday\n\nNewer",
      },
      {
        name: "is kept when its inline formatting differs",
        survivor: "# Friday\n\nOlder",
        duplicate: "# **Friday**\n\nNewer",
        merged: "# Friday\n\nOlder\n\n# **Friday**\n\nNewer",
      },
      {
        name: "is not what an equal first paragraph is: that block is appended",
        survivor: "Friday\n\nOlder",
        duplicate: "Friday\n\nNewer",
        merged: "Friday\n\nOlder\n\nFriday\n\nNewer",
      },
      {
        name: "is appended with the rest when the survivor has no page",
        survivor: null,
        duplicate: "# Friday\n\nNewer",
        merged: "# Friday\n\nNewer",
      },
    ])("$name", async ({ survivor, duplicate, merged }) => {
      const { older, newer } = await duplicatedDay();
      if (survivor !== null) await write(older, survivor);
      await write(newer, duplicate);

      await merge();

      expect(await page(older)).toBe(merged);
    });

    it.each([
      { name: "a duplicate without a page", duplicate: null },
      { name: "a duplicate whose page is only the survivor's heading", duplicate: "# Friday" },
    ])("appends nothing for $name", async ({ duplicate }) => {
      const { older, newer } = await duplicatedDay();
      await write(older, "# Friday\n\nOlder");
      if (duplicate !== null) await write(newer, duplicate);
      const before = await stored();

      expect(await merge()).toEqual({ survivorId: older, mergedItemId: newer, refusedEdges: [] });

      expect(await page(older)).toBe("# Friday\n\nOlder");
      const after = await stored();
      expect(after.docUpdates).toEqual(before.docUpdates);
      expect(after.docs).toEqual(before.docs);
    });
  });

  describe("edges that are not moved", () => {
    it("leaves an edge to a trashed item on the duplicate and reports it", async () => {
      const { older, newer } = await duplicatedDay();
      const gone = await createNamed(ids.areas, "Gone");
      const work = await createNamed(ids.areas, "Work");
      await link("area", newer, gone);
      await link("area", newer, work);
      await runInTenant(tenant, () => cp.softDeleteItem(ids.areas, gone));
      const { property: area } = await relationProperty(ids.journal, "area");

      expect(await merge()).toEqual({
        survivorId: older,
        mergedItemId: newer,
        refusedEdges: [
          { relationPropertyId: area.id, otherItemId: gone, code: "validation_failed", field: "targetItemId" },
        ],
      });

      expect(await relatedIds(ids.journal, "area", older)).toEqual([work]);
      expect(await relatedIds(ids.journal, "area", newer)).toEqual([gone]);
      expect(refusedEdgeLog.mock.calls).toEqual([
        [
          {
            survivorId: older,
            mergedItemId: newer,
            relationPropertyId: area.id,
            otherItemId: gone,
            code: "validation_failed",
          },
          REFUSED_EDGE_MESSAGE,
        ],
      ]);
    });

    it("leaves a stored area on the duplicate when the survivor's area is derived from its project and reports it", async () => {
      const { older, newer } = await duplicatedDay();
      const project = await createNamed(ids.projects, "Garden");
      const home = await createNamed(ids.areas, "Home");
      await link("project", older, project);
      await link("area", newer, home);
      const { property: area } = await relationProperty(ids.journal, "area");

      expect(await merge()).toEqual({
        survivorId: older,
        mergedItemId: newer,
        refusedEdges: [{ relationPropertyId: area.id, otherItemId: home, code: "validation_failed", field: "area" }],
      });

      expect(await relatedIds(ids.journal, "area", older)).toEqual([]);
      expect(await relatedIds(ids.journal, "area", newer)).toEqual([home]);
      expect(await relatedIds(ids.journal, "project", older)).toEqual([project]);
      expect(refusedEdgeLog.mock.calls).toEqual([
        [
          {
            survivorId: older,
            mergedItemId: newer,
            relationPropertyId: area.id,
            otherItemId: home,
            code: "validation_failed",
          },
          REFUSED_EDGE_MESSAGE,
        ],
      ]);
    });

    it("leaves the edge of a trashed Inbox item on the duplicate and reports it", async () => {
      const { older, newer } = await duplicatedDay();
      const trashed = await capture("Trashed note");
      const live = await capture("Live note");
      await runInTenant(tenant, () => cp.softDeleteItem(ids.inbox, trashed));
      const { property: journalDay } = await relationProperty(ids.inbox, "journalDay");

      expect(await merge()).toEqual({
        survivorId: older,
        mergedItemId: newer,
        refusedEdges: [
          { relationPropertyId: journalDay.id, otherItemId: trashed, code: "validation_failed", field: "callerItemId" },
        ],
      });

      expect(await relatedIds(ids.inbox, "journalDay", trashed)).toEqual([newer]);
      expect(await relatedIds(ids.inbox, "journalDay", live)).toEqual([older]);
      expect(refusedEdgeLog.mock.calls).toEqual([
        [
          {
            survivorId: older,
            mergedItemId: newer,
            relationPropertyId: journalDay.id,
            otherItemId: trashed,
            code: "validation_failed",
          },
          REFUSED_EDGE_MESSAGE,
        ],
      ]);
    });

    it("leaves an edge a domain rule refuses for the survivor on the duplicate and reports it without a field", async () => {
      const { older, newer } = await duplicatedDay();
      const home = await createNamed(ids.areas, "Home");
      await link("area", newer, home);
      const { property: area } = await relationProperty(ids.journal, "area");
      refuseEdgeCheckOf = older;

      expect(await merge()).toEqual({
        survivorId: older,
        mergedItemId: newer,
        refusedEdges: [{ relationPropertyId: area.id, otherItemId: home, code: "validation_failed", field: null }],
      });

      expect(await relatedIds(ids.journal, "area", older)).toEqual([]);
      expect(await relatedIds(ids.journal, "area", newer)).toEqual([home]);
      expect(refusedEdgeLog).toHaveBeenCalledTimes(1);
    });

    it("reports the edges left on the duplicate across relation properties, one log line each", async () => {
      const { older, newer } = await duplicatedDay();
      const gone = await createNamed(ids.areas, "Gone");
      await link("area", newer, gone);
      await runInTenant(tenant, () => cp.softDeleteItem(ids.areas, gone));
      const trashed = await capture("Trashed note");
      await runInTenant(tenant, () => cp.softDeleteItem(ids.inbox, trashed));
      const { property: area } = await relationProperty(ids.journal, "area");
      const { property: journalDay } = await relationProperty(ids.inbox, "journalDay");

      const merged = await merge();

      expect(merged).toEqual({
        survivorId: older,
        mergedItemId: newer,
        refusedEdges: [
          { relationPropertyId: area.id, otherItemId: gone, code: "validation_failed", field: "targetItemId" },
          { relationPropertyId: journalDay.id, otherItemId: trashed, code: "validation_failed", field: "callerItemId" },
        ],
      });
      expect(refusedEdgeLog.mock.calls.map(([fields]) => fields)).toEqual([
        {
          survivorId: older,
          mergedItemId: newer,
          relationPropertyId: area.id,
          otherItemId: gone,
          code: "validation_failed",
        },
        {
          survivorId: older,
          mergedItemId: newer,
          relationPropertyId: journalDay.id,
          otherItemId: trashed,
          code: "validation_failed",
        },
      ]);
    });

    it("logs no refused edge when the caller's transaction is rolled back after the merge", async () => {
      const { newer } = await duplicatedDay();
      const gone = await createNamed(ids.areas, "Gone");
      await link("area", newer, gone);
      await runInTenant(tenant, () => cp.softDeleteItem(ids.areas, gone));
      const before = await everything();
      let refused: number | undefined;

      await expect(
        runInTenant(tenant, () =>
          withTransaction(pool, async (client) => {
            const merged = await mergeJournalDuplicates(client, { periodType: "day", period: DAY });
            refused = merged?.refusedEdges.length;
            throw new Error("caller failure after the merge");
          }),
        ),
      ).rejects.toThrow("caller failure after the merge");

      expect(refused).toBe(1);
      expect(refusedEdgeLog).not.toHaveBeenCalled();
      expect(await everything()).toEqual(before);
    });

    it("does not give the survivor an edge that was removed while the merge ran", async () => {
      const { older, newer } = await duplicatedDay();
      const home = await createNamed(ids.areas, "Home");
      await link("area", newer, home);
      const { property } = await relationProperty(ids.journal, "area");
      removeConcurrently = { relationPropertyId: property.id, callerItemId: newer, targetItemId: home };

      expect(await merge()).toEqual({ survivorId: older, mergedItemId: newer, refusedEdges: [] });

      expect(removeConcurrently).toBeNull();
      expect(await relatedIds(ids.journal, "area", older)).toEqual([]);
      expect(await relatedIds(ids.journal, "area", newer)).toEqual([]);
      expect(refusedEdgeLog).not.toHaveBeenCalled();
    });
  });

  describe("a period without a duplicate", () => {
    it("changes nothing when the merge is run again", async () => {
      const { older, newer } = await duplicatedDay();
      await write(older, "# Friday\n\nOlder");
      await write(newer, "# Friday\n\nNewer");
      await link("area", newer, await createNamed(ids.areas, "Home"));
      await capture("A note");
      expect(await merge()).toEqual({ survivorId: older, mergedItemId: newer, refusedEdges: [] });
      const merged = await everything();
      invalidations = [];

      expect(await merge()).toBeNull();

      expect(await everything()).toEqual(merged);
      expect(invalidations).toEqual([]);
    });

    it.each([
      {
        name: "has one live entry",
        arrange: async () => {
          await write(await reservedEntry(), "Only");
        },
      },
      {
        name: "has no entry while two other days have one each",
        arrange: async () => {
          await unreservedEntry("2026-10-17");
          await unreservedEntry("2026-10-18");
        },
      },
      {
        name: "has a second entry that is already in the Trash",
        arrange: async () => {
          const { newer } = await duplicatedDay();
          await runInTenant(tenant, () => cp.softDeleteItem(ids.journal, newer));
        },
      },
    ])("returns null and writes nothing when the period $name", async ({ arrange }) => {
      await arrange();
      const before = await everything();
      invalidations = [];

      expect(await merge()).toBeNull();

      expect(await everything()).toEqual(before);
      expect(invalidations).toEqual([]);
    });

    it("merges the entries of a week, and only when asked for that period type", async () => {
      const [first, second] = [
        await runInTenant(tenant, () =>
          withTransaction(pool, (client) => createUnreservedEntry(client, ids.journal, "2026-W42", "week")),
        ),
        await runInTenant(tenant, () =>
          withTransaction(pool, (client) => createUnreservedEntry(client, ids.journal, "2026-W42", "week")),
        ),
      ];

      expect(await merge("2026-W42", "day")).toBeNull();
      expect(await merge("2026-W42", "week")).toEqual({ survivorId: first, mergedItemId: second, refusedEdges: [] });
    });

    it("merges one duplicate per call when the period has three live entries", async () => {
      const first = await unreservedEntry();
      const second = await reservedEntry();
      const third = await unreservedEntry();
      await write(first, "one");
      await write(second, "two");
      await write(third, "three");

      expect(await merge()).toEqual({ survivorId: first, mergedItemId: second, refusedEdges: [] });
      expect(await merge()).toEqual({ survivorId: first, mergedItemId: third, refusedEdges: [] });
      expect(await merge()).toBeNull();

      expect(await page(first)).toBe("one\n\ntwo\n\nthree");
      expect((await periodEntries()).filter((entry) => entry.live)).toEqual([{ id: first, live: true }]);
      expect(await reservation()).toBe(first);
    });
  });

  describe("a merge that fails", () => {
    /** Two live entries with a page each; the newer one also has an area, a project and an Inbox item to move. */
    async function populatedDuplicates(): Promise<{ older: string; newer: string }> {
      const { older, newer } = await duplicatedDay();
      await write(older, "# Friday\n\nOlder");
      await write(newer, "# Friday\n\nNewer");
      await link("area", newer, await createNamed(ids.areas, "Home"));
      await link("project", newer, await createNamed(ids.projects, "Garden"));
      await capture("A note");
      return { older, newer };
    }

    it.each([
      {
        name: "when the check of an edge for the survivor fails with an error that is not a refusal",
        arm: (pair: { older: string; newer: string }) => {
          failEdgeCheckOf = pair.older;
        },
        message: "injected check failure",
      },
      {
        name: "halfway, when the first edge is created on the survivor",
        arm: (pair: { older: string; newer: string }) => {
          failEdgeCreatedOn = pair.older;
        },
        message: "injected edge failure",
      },
      {
        name: "at its last step, when the duplicate is trashed",
        arm: (pair: { older: string; newer: string }) => {
          failTrashOf = pair.newer;
        },
        message: "injected trash failure",
      },
    ])("leaves both entries unchanged when it fails $name", async ({ arm, message }) => {
      const pair = await populatedDuplicates();
      const before = await everything();
      invalidations = [];
      arm(pair);

      await expect(merge()).rejects.toThrow(message);

      expect(await everything()).toEqual(before);
      expect(await page(pair.older)).toBe("# Friday\n\nOlder");
      expect(await periodEntries()).toEqual(
        [
          { id: pair.older, live: true },
          { id: pair.newer, live: true },
        ].sort((x, y) => byCodeUnit(x.id, y.id)),
      );
      expect(await reservation()).toBe(pair.newer);
      expect(invalidations).toEqual([]);
    });

    it("fails with the page insertion's refusal and changes nothing when the duplicate's page links a trashed item", async () => {
      const pair = await populatedDuplicates();
      const task = await createNamed(ids.tasks, "Follow up");
      await write(pair.newer, `See [Follow up](semprec://items/${task})`);
      await runInTenant(tenant, () => cp.softDeleteItem(ids.tasks, task));
      const before = await everything();

      const error = await rejection(merge());

      if (!(error instanceof ValidationError)) throw new Error(`Expected a ValidationError, got ${String(error)}`);
      expect(error.details).toEqual({ field: "markdown" });
      expect(await everything()).toEqual(before);
      expect(await reservation()).toBe(pair.newer);
    });

    it("fails with the page insertion's refusal and changes nothing when the duplicate's page holds a subpage", async () => {
      const pair = await populatedDuplicates();
      await runInTenant(tenant, () =>
        withTransaction(pool, (client) =>
          createSubpageWithClient(client, { parent: { itemId: pair.newer }, title: "Details" }, "user"),
        ),
      );
      const before = await everything();

      const error = await rejection(merge());

      if (!(error instanceof ValidationError)) throw new Error(`Expected a ValidationError, got ${String(error)}`);
      expect(error.details).toMatchObject({ field: "markdown", reason: "page_not_allowed" });
      expect(await everything()).toEqual(before);
    });

    it("fails with 409 and changes nothing when the period's reservation key belongs to another database", async () => {
      await unreservedEntry();
      await unreservedEntry();
      await runInTenant(tenant, () =>
        cp.createItem({ databaseId: ids.tasks, properties: { name: "Foreign key" }, idempotencyKey: reservationKey() }),
      );
      const before = await everything();

      const error = await rejection(merge());

      if (!(error instanceof ConflictError)) throw new Error(`Expected a ConflictError, got ${String(error)}`);
      expect(error.details).toEqual({ key: reservationKey() });
      expect(await everything()).toEqual(before);
    });

    it("fails and changes nothing when the Inbox journalDay relation is missing", async () => {
      await populatedDuplicates();
      // A broken schema no writer produces: the locked Inbox schema cannot lose a property through the public writer.
      await runInTenant(tenant, async () => {
        const removed = await pool.query("DELETE FROM properties WHERE database_id = $1 AND key = 'journalDay'", [
          ids.inbox,
        ]);
        expect(removed.rowCount).toBe(1);
      });
      const before = await everything();

      await expect(merge()).rejects.toThrow("Inbox 'journalDay' relation not found");

      expect(await everything()).toEqual(before);
    });

    it("refuses a client that is not in a managed transaction, before it writes", async () => {
      await populatedDuplicates();
      const before = await everything();

      await expect(
        runInTenant(tenant, () =>
          withClient(pool, (client) => mergeJournalDuplicates(client, { periodType: "day", period: DAY })),
        ),
      ).rejects.toThrow("requires an active managed transaction");

      expect(await everything()).toEqual(before);
    });

    it("fails with 404 in a tenant that has no Journal database", async () => {
      const unseeded = await createTestTenant(admin);

      const error = await rejection(merge(DAY, "day", unseeded));

      if (!(error instanceof NotFoundError)) throw new Error(`Expected a NotFoundError, got ${String(error)}`);
      expect(error.message).toBe("Journal database not found");
    });
  });

  describe("concurrent writers of one period", () => {
    it("lets the second of two concurrent merges wait for the first and find nothing left to merge", async () => {
      const { older, newer } = await duplicatedDay();
      await write(older, "Older");
      await write(newer, "Newer");

      const [first, second] = await contended(
        (client) => mergeJournalDuplicates(client, { periodType: "day", period: DAY }),
        (client) => mergeJournalDuplicates(client, { periodType: "day", period: DAY }),
      );

      expect(first).toEqual({
        status: "fulfilled",
        value: { survivorId: older, mergedItemId: newer, refusedEdges: [] },
      });
      expect(second).toEqual({ status: "fulfilled", value: null });
      expect(await page(older)).toBe("Older\n\nNewer");
      expect((await periodEntries()).filter((entry) => entry.live)).toEqual([{ id: older, live: true }]);
    });

    it("hands a lazy create that waited on a merge the survivor, with no new entry", async () => {
      const { older } = await duplicatedDay();

      const [merged, created] = await contended(
        (client) => mergeJournalDuplicates(client, { periodType: "day", period: DAY }),
        async (client) => (await getOrCreateJournalItem(client, ids.journal, "day", REFERENCE, ZONE)).id,
      );

      expect(merged.status).toBe("fulfilled");
      expect(created).toEqual({ status: "fulfilled", value: older });
      expect(await periodEntries()).toHaveLength(2);
    });

    it("waits for the reservation before it locks an entry", async () => {
      const { older, newer } = await duplicatedDay();

      const [created, merged] = await contended(
        async (client) => (await getOrCreateJournalItem(client, ids.journal, "day", REFERENCE, ZONE)).id,
        (client) => mergeJournalDuplicates(client, { periodType: "day", period: DAY }),
        async () => {
          // While the merge waits for the reservation the lazy create holds, both entry rows can still be locked.
          const { rows } = await runInTenant(tenant, () =>
            withTransaction(pool, (client) =>
              client.query<{ id: string }>(
                "SELECT id FROM items WHERE database_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE NOWAIT",
                [ids.journal, [older, newer]],
              ),
            ),
          );
          expect(rows.map((row) => row.id)).toEqual([older, newer].sort());
        },
      );

      expect(created).toEqual({ status: "fulfilled", value: newer });
      expect(merged).toEqual({
        status: "fulfilled",
        value: { survivorId: older, mergedItemId: newer, refusedEdges: [] },
      });
    });

    it("holds both entries row-locked before it reads a page", async () => {
      const { older, newer } = await duplicatedDay();
      await write(newer, "Newer");
      const lockOf = (itemId: string): Promise<unknown> =>
        rejection(
          runInTenant(tenant, () =>
            withTransaction(pool, (client) =>
              client.query<{ id: string }>(
                "SELECT id FROM items WHERE database_id = $1 AND id = $2 FOR UPDATE NOWAIT",
                [ids.journal, itemId],
              ),
            ),
          ),
        );

      const [, merged] = await contended(
        // Reading a page holds its document rows locked, so the merge stops at its own first page read.
        (client) => readPageMarkdown(client, newer),
        (client) => mergeJournalDuplicates(client, { periodType: "day", period: DAY }),
        async () => {
          for (const itemId of [older, newer]) {
            const error = await lockOf(itemId);
            if (!(error instanceof DatabaseError)) throw new Error(`Expected a lock failure, got ${String(error)}`);
            // 55P03 lock_not_available: the merge already holds the row.
            expect(error.code).toBe("55P03");
          }
        },
      );

      expect(merged).toEqual({
        status: "fulfilled",
        value: { survivorId: older, mergedItemId: newer, refusedEdges: [] },
      });
    });
  });

  describe("the choke point's edge move on a relation with a cardinality limit", () => {
    it("fails with the insert's cardinality violation, and changes nothing, when the receiving item already holds its only edge", async () => {
      // Tasks.project is the single-valued side of a one_to_many relation; the relations the merge moves are many_to_many.
      const { property } = await relationProperty(ids.tasks, "project");
      const from = await createNamed(ids.tasks, "From");
      const to = await createNamed(ids.tasks, "To");
      const first = await createNamed(ids.projects, "First");
      const second = await createNamed(ids.projects, "Second");
      for (const [task, project] of [
        [from, first],
        [to, second],
      ] as const) {
        await runInTenant(tenant, () =>
          cp.createRelation({ relationPropertyId: property.id, callerItemId: task, targetItemId: project }),
        );
      }
      const before = await everything();

      const error = await rejection(
        runInTenant(tenant, () =>
          withTransaction(pool, (client) =>
            moveRelationEdgesWithClient(client, {
              relationPropertyId: property.id,
              side: "caller",
              fromItemId: from,
              toItemId: to,
            }),
          ),
        ),
      );

      expect(error).toBeInstanceOf(CardinalityViolationError);
      expect(await relatedIds(ids.tasks, "project", from)).toEqual([first]);
      expect(await relatedIds(ids.tasks, "project", to)).toEqual([second]);
      expect(await everything()).toEqual(before);
    });
  });

  it("merges only the caller's tenant", async () => {
    const other = await createTestTenant(admin);
    await runInTenant(other, () => seedSystem(pool));
    const otherIds = await databaseIds(other);
    const foreign = await duplicatedDay(other, otherIds);
    await write(foreign.older, "Foreign older", other);
    await write(foreign.newer, "Foreign newer", other);
    await link("area", foreign.newer, await createNamed(otherIds.areas, "Foreign", other), {}, other, otherIds);
    const foreignItem = await capture("Foreign note", other, otherIds);
    const before = await stored(other);
    const { older, newer } = await duplicatedDay();

    expect(await merge()).toEqual({ survivorId: older, mergedItemId: newer, refusedEdges: [] });

    expect(await stored(other)).toEqual(before);
    expect(await periodEntries(DAY, other, otherIds)).toEqual(
      [
        { id: foreign.older, live: true },
        { id: foreign.newer, live: true },
      ].sort((x, y) => byCodeUnit(x.id, y.id)),
    );
    expect(await relatedIds(otherIds.inbox, "journalDay", foreignItem, other)).toEqual([foreign.newer]);
    expect(await reservation(DAY, other, otherIds)).toBe(foreign.newer);
  });
});
