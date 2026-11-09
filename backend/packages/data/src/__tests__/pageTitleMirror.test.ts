import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import pg, { type Pool, type PoolClient } from "pg";
import { writeBlock } from "@semprec/block-model";
import { runInTenant } from "@semprec/shared";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import { countJobsByIdentifier } from "@semprec/queue/testSupport";
import "../domainWriteHooks.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { mutateDoc } from "../docs/docPersistence.js";
import { getOrCreateDoc } from "../docs/docsStore.js";
import { createSubpageWithClient } from "../docs/pageOperations.js";
import { handlePageTitleMirrorTask } from "../docs/pageTitleMirrorJob.js";
import { PAGE_TITLE_MAX_LENGTH } from "../docs/pageTitle.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createActionRegistry } from "../scheduler/actions.js";
import { createApiCoreTaskList } from "../worker.js";

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;
let tenant: string;
const taskName = CORE_TASK_NAMES.PAGE_TITLE_MIRROR;
const DEBOUNCE_MS = 10_000;

/**
 * Set while an actor the race tests started has not settled (its backend may still hold locks): the file then refuses to
 * reset the database or close the shared pools. `recover` finishes the cleanup once the actors have settled.
 */
let abandoned: { names: string[]; recover: () => Promise<void> } | undefined;

function assertNoAbandonedActors(): void {
  if (abandoned !== undefined) {
    throw new Error(
      `Owned actors are not settled (${abandoned.names.join(", ")}); the shared database and pools stay as they are`,
    );
  }
}

/*
 * Tenant scope is entered per helper and never around `runOnce`: the queue drain is a system scope, and the
 * production task list enters each job's own tenant from its envelope.
 */
function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runInTenant(tenant, fn);
}
function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return inTenant(() => withTransaction(pool, fn));
}

async function host(name = "Host"): Promise<string> {
  const databaseId = await inTransaction(async (client) => {
    const database = await getDatabaseByModuleId(client, "tasks");
    if (!database) throw new Error("Missing Tasks database");
    return database.id;
  });
  return (await inTenant(() => cp.createItem({ databaseId, properties: { name } }))).id;
}

interface Subpage {
  pageItemId: string;
  blockId: string;
}

async function subpage(parent: string, title: string): Promise<Subpage> {
  const created = await inTransaction((client) =>
    createSubpageWithClient(client, { parent: { itemId: parent }, title }, "user"),
  );
  const page = created.pages[0];
  if (!page) throw new Error("Missing page");
  return page;
}

/** Types `text` as the title of the page block `blockId`, the way a sync client does: through the block's Y.Text. */
async function typeTitle(parent: string, blockId: string, text: string): Promise<void> {
  await inTenant(async () => {
    const doc = await withTransaction(pool, (client) => getOrCreateDoc(client, parent, "page"));
    await mutateDoc(pool, doc.id, "user", (ydoc) => {
      const block = ydoc.getMap<Y.Map<unknown>>("blocks").get(blockId);
      const title = block?.get("text");
      if (!(title instanceof Y.Text)) throw new Error(`Block ${blockId} has no text`);
      title.delete(0, title.length);
      title.insert(0, text);
    });
  });
}

async function titleOf(itemId: string): Promise<string | undefined> {
  return inTransaction(async (client) => {
    const { rows } = await client.query<{ title: string | null }>(
      `SELECT properties->>'title' AS title FROM items WHERE id = $1`,
      [itemId],
    );
    return rows[0]?.title ?? undefined;
  });
}

async function trash(itemId: string): Promise<void> {
  const databaseId = await inTransaction(async (client) => {
    const { rows } = await client.query<{ database_id: string }>(`SELECT database_id FROM items WHERE id = $1`, [
      itemId,
    ]);
    const row = rows[0];
    if (!row) throw new Error(`Missing item ${itemId}`);
    return row.database_id;
  });
  await inTenant(() => cp.softDeleteItem(databaseId, itemId));
}

async function versionOf(itemId: string): Promise<string | undefined> {
  return inTransaction(async (client) => {
    const { rows } = await client.query<{ updated_at: Date }>(`SELECT updated_at FROM items WHERE id = $1`, [itemId]);
    return rows[0]?.updated_at.toISOString();
  });
}

/** The queued jobs' run times, read from Graphile Worker's public `jobs` view (which has no payload column). */
async function queuedJobs(): Promise<Array<{ key: string | null; run_at: Date }>> {
  const result = await admin.query<{ key: string | null; run_at: Date }>(
    "SELECT key, run_at FROM graphile_worker.jobs WHERE task_identifier = $1 ORDER BY id",
    [taskName],
  );
  return result.rows;
}

/** Drains the queue once with the production API task list, as the worker does. */
async function runMirrorJobs(): Promise<void> {
  const handler = createApiCoreTaskList(pool, createActionRegistry())[taskName];
  if (!handler) throw new Error("The mirror handler is missing from the production API task list");
  await runOnce({ pgPool: admin }, { [taskName]: handler });
}

beforeAll(async () => {
  admin = getTestPool();
  pool = await createRuntimeRolePool(admin, "semprec_data");
  cp = createChokePoint(pool);
});
beforeEach(async () => {
  assertNoAbandonedActors();
  await resetDatabase(admin);
  tenant = getTenantZeroId();
  await inTenant(() => seedSystem(pool));
  // Edits are written 60 seconds in the past, so their 10-second debounce has elapsed when the queue is drained.
  // Only `Date` is faked; the database clock and Graphile Worker's polling are untouched.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() - 60_000);
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(async () => {
  assertNoAbandonedActors();
  await pool?.end();
  await admin?.end();
});

describe("subpage title mirror (issue #1715)", () => {
  it("copies a title typed in the parent onto the Pages item once the job has run", async () => {
    const parent = await host();
    const page = await subpage(parent, "Old title");
    await typeTitle(parent, page.blockId, "New title");
    expect(await titleOf(page.pageItemId)).toBe("Old title");

    await runMirrorJobs();

    expect(await titleOf(page.pageItemId)).toBe("New title");
    expect(await countJobsByIdentifier(admin, taskName)).toBe(0);
  });

  it("queues one job for a burst of edits and keeps the first edit's run time", async () => {
    const parent = await host();
    const firstEdit = Date.now();
    const page = await subpage(parent, "One");
    vi.setSystemTime(firstEdit + 4_000);
    await typeTitle(parent, page.blockId, "Two");
    vi.setSystemTime(firstEdit + 8_000);
    await typeTitle(parent, page.blockId, "Three");

    expect(await countJobsByIdentifier(admin, taskName)).toBe(1);
    expect(await queuedJobs()).toEqual([
      { key: `page-title-mirror:${parent}`, run_at: new Date(firstEdit + DEBOUNCE_MS) },
    ]);
    await runMirrorJobs();
    expect(await titleOf(page.pageItemId)).toBe("Three");
  });

  it("queues no job for a canvas document write, and none for an edit that rolls back", async () => {
    const item = await host();
    await inTenant(async () => {
      const canvas = await withTransaction(pool, (client) => getOrCreateDoc(client, item, "canvas"));
      await mutateDoc(pool, canvas.id, "user", (ydoc) => ydoc.getMap("elements").set("x", 1));
    });
    expect(await countJobsByIdentifier(admin, taskName)).toBe(0);

    const parent = await host("Rolled back");
    const aborted = new Error("abort edit");
    await expect(
      inTransaction(async (client) => {
        await createSubpageWithClient(client, { parent: { itemId: parent }, title: "Never" }, "user");
        throw aborted;
      }),
    ).rejects.toBe(aborted);
    expect(await countJobsByIdentifier(admin, taskName)).toBe(0);
  });

  it("stores a title with a line break with a space, and cuts an over-long title instead of failing", async () => {
    const parent = await host();
    const lineBreak = await subpage(parent, "A");
    const tooLong = await subpage(parent, "B");
    await typeTitle(parent, lineBreak.blockId, "Line one\nline two");
    await typeTitle(parent, tooLong.blockId, "x".repeat(PAGE_TITLE_MAX_LENGTH + 100));

    await runMirrorJobs();

    expect(await titleOf(lineBreak.pageItemId)).toBe("Line one line two");
    expect(await titleOf(tooLong.pageItemId)).toBe("x".repeat(PAGE_TITLE_MAX_LENGTH));
  });

  it("writes nothing for a trashed page, a page of another parent, an unknown id or an item of another database", async () => {
    const parent = await host("Parent");
    const other = await host("Other parent");
    const trashed = await subpage(parent, "Trashed original");
    const foreign = await subpage(other, "Foreign original");
    const unrelated = await host("Unrelated item");
    await trash(trashed.pageItemId);
    const mirrored = await subpage(parent, "Mirrored original");

    // The parent document holds page blocks for each of them, all retitled by hand (a sync client may write any pageId).
    await inTenant(async () => {
      const doc = await withTransaction(pool, (client) => getOrCreateDoc(client, parent, "page"));
      await mutateDoc(pool, doc.id, "user", (ydoc) => {
        for (const [blockId, pageId] of [
          ["to-trashed", trashed.pageItemId],
          ["to-foreign", foreign.pageItemId],
          ["to-unknown", randomUUID()],
          ["to-unrelated", unrelated],
          ["to-malformed", "not-a-uuid"],
        ] as const) {
          writeBlock(ydoc, { id: blockId, type: "page", pageId, text: "Hijacked" });
        }
      });
    });
    await typeTitle(parent, mirrored.blockId, "Mirrored new");
    const versions = await Promise.all([trashed.pageItemId, foreign.pageItemId, unrelated].map(versionOf));

    await runMirrorJobs();

    expect(await titleOf(mirrored.pageItemId)).toBe("Mirrored new");
    expect(await titleOf(trashed.pageItemId)).toBe("Trashed original");
    expect(await titleOf(foreign.pageItemId)).toBe("Foreign original");
    expect(await titleOf(unrelated)).toBeUndefined();
    expect(await Promise.all([trashed.pageItemId, foreign.pageItemId, unrelated].map(versionOf))).toEqual(versions);
  });

  it("leaves an item whose title already equals the block text untouched", async () => {
    const parent = await host();
    const page = await subpage(parent, "Same");
    const before = await versionOf(page.pageItemId);
    await typeTitle(parent, page.blockId, "Same");
    await runMirrorJobs();
    expect(await versionOf(page.pageItemId)).toBe(before);
  });

  it("completes without writing for a missing item, a trashed item, an item without a page and a tenant without Pages", async () => {
    const trashedParent = await host("Trashed parent");
    const page = await subpage(trashedParent, "Kept");
    await typeTitle(trashedParent, page.blockId, "Changed");
    await trash(trashedParent);
    const noPage = await host("No page");
    const before = await versionOf(page.pageItemId);

    for (const itemId of [randomUUID(), trashedParent, noPage]) {
      await inTenant(() => handlePageTitleMirrorTask(pool, { itemId }));
    }
    expect(await titleOf(page.pageItemId)).toBe("Kept");
    expect(await versionOf(page.pageItemId)).toBe(before);

    // A tenant that never created a subpage has no Pages database: its job completes without looking further.
    const otherTenant = await createTestTenant(admin);
    const otherItem = await runInTenant(otherTenant, async () => {
      const chokePoint = createChokePoint(pool);
      const database = await chokePoint.createDatabase({ name: "Other tenant" });
      const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
      await withTransaction(pool, (client) => getOrCreateDoc(client, item.id, "page"));
      return item.id;
    });
    await runInTenant(otherTenant, () => handlePageTitleMirrorTask(pool, { itemId: otherItem }));
  });

  describe("host trash racing the mirror (issue #1715 repair)", () => {
    type Settled = { ok: true; value: unknown } | { ok: false; error: unknown };

    /** A backend the test started or owns: its process id and the start time that tells it apart from a reused id. */
    interface Session {
      pid: number;
      backendStart: string;
    }

    /** An operation the test started on a session of its own, with its outcome observed from the moment it starts. */
    interface Actor {
      name: string;
      session: Session;
      done: boolean;
      /** Set when the operation ends, so a failed run can name its own rejection without awaiting it. */
      settled: Settled | undefined;
      outcome: Promise<Settled>;
    }

    interface StatementRule {
      match: (text: string, values: readonly unknown[]) => boolean;
      inject: () => Promise<void>;
    }

    function startActor(name: string, session: Session, run: () => Promise<unknown>): Actor {
      const actor: Actor = {
        name,
        session,
        done: false,
        settled: undefined,
        outcome: Promise.resolve({ ok: true, value: undefined }),
      };
      actor.outcome = run().then(
        (value): Settled => {
          actor.done = true;
          actor.settled = { ok: true, value };
          return actor.settled;
        },
        (error: unknown): Settled => {
          actor.done = true;
          actor.settled = { ok: false, error };
          return actor.settled;
        },
      );
      return actor;
    }

    /**
     * Runs each rule's `inject` once, right after the first statement that matches it has finished and before the
     * statement's caller sees the result. A rule disarms itself before its `inject` runs, so the statements the
     * injection causes are not intercepted by that rule again.
     */
    function onStatements(rules: StatementRule[]): { restore: () => void; fired: (index: number) => boolean } {
      const armed = rules.map(() => true);
      // Called back with the receiving client below, so the unbound reference is safe.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const originalQuery: (this: pg.Client, ...args: unknown[]) => unknown = pg.Client.prototype.query;
      const spy = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (
        this: pg.Client,
        ...args: unknown[]
      ) {
        const result = originalQuery.apply(this, args);
        const [text, values] = args;
        if (typeof text !== "string" || !(result instanceof Promise)) return result;
        const index = rules.findIndex(
          (rule, i) => armed[i] === true && rule.match(text, Array.isArray(values) ? values : []),
        );
        const rule = rules[index];
        if (rule === undefined) return result;
        armed[index] = false;
        return result.then(async (value: unknown) => {
          await rule.inject();
          return value;
        });
      });
      return { restore: () => spy.mockRestore(), fired: (index) => armed[index] === false };
    }

    /** A pool of one connection whose backend identity is read before any actor uses it. */
    async function ownedPool(observer: PoolClient): Promise<{ pool: Pool; session: Session }> {
      const owned = await createRuntimeRolePool(admin, "semprec_data");
      try {
        owned.options.max = 1;
        expect(owned.options.max).toBe(1);
        const { rows } = await owned.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const pid = rows[0]?.pid;
        if (pid === undefined) throw new Error("The owned pool reported no backend pid");
        const started = await observer.query<{ started: string }>(
          "SELECT backend_start::text AS started FROM pg_stat_activity WHERE pid = $1",
          [pid],
        );
        const backendStart = started.rows[0]?.started;
        if (backendStart === undefined) throw new Error("The owned backend is not visible to the observer");
        return { pool: owned, session: { pid, backendStart } };
      } catch (error) {
        await owned.end().catch((endError: unknown) => {
          throw new AggregateError([error, endError], "Owned pool setup and release both failed", { cause: error });
        });
        throw error;
      }
    }

    /** A promise the test resolves by hand: a gate an injected statement can wait on. */
    function gateOf(): { promise: Promise<void>; release: () => void } {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    }

    /**
     * Test-local deadlines and fault injection for the failure controls; the defaults are the bounds of a real run.
     * `attempted` and `sessions` are filled by the helpers, so a control can read them after the call failed.
     */
    interface Faults {
      /** The bound on the first wait for the job(s). */
      outcomeMs: number;
      /** The bound on each wait of `settleActors`. */
      settleMs: number;
      /** Actors whose guarded termination fails with an injected error instead of reaching the database. */
      failTerminateFor: string[];
      /** Adds one cleanup step that throws, so the cleanup itself fails. */
      failCleanup: boolean;
      attempted: string[];
      sessions: Session[];
    }

    function faultsOf(overrides: Partial<Omit<Faults, "attempted" | "sessions">> = {}): Faults {
      return {
        outcomeMs: 10_000,
        settleMs: 5_000,
        failTerminateFor: [],
        failCleanup: false,
        attempted: [],
        sessions: [],
        ...overrides,
      };
    }

    const failingCleanup = (): Promise<void> => Promise.reject(new Error("Injected cleanup failure"));

    /** Whether every actor has settled within `ms`; the timer is cleared on every result. */
    async function boundedSettled(actors: Actor[], ms: number): Promise<boolean> {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          Promise.allSettled(actors.map((actor) => actor.outcome)).then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), ms);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }

    async function within(actors: Actor[], ms: number, what: string): Promise<void> {
      if (!(await boundedSettled(actors, ms))) throw new Error(`${what} did not settle within ${ms} ms`);
    }

    /**
     * Waits for every actor's own outcome. When some are still pending after the bound, a guarded termination of each
     * pending actor's backend is attempted independently (only while its pid and start time still match; a failed
     * attempt is recorded and the next actor is still tried) and the actors are awaited once more. Settlement is the
     * actors' own outcomes, never the result of a termination: `unsettled` names the actors that still have none, and
     * `errors` holds the termination failures, which do not by themselves mean an actor is unsettled.
     */
    async function settleActors(
      observer: PoolClient,
      actors: Actor[],
      faults: Faults,
    ): Promise<{ unsettled: string[]; errors: unknown[] }> {
      const errors: unknown[] = [];
      if (await boundedSettled(actors, faults.settleMs)) return { unsettled: [], errors };
      for (const actor of actors.filter((candidate) => !candidate.done)) {
        faults.attempted.push(actor.name);
        try {
          if (faults.failTerminateFor.includes(actor.name)) {
            throw new Error(`Injected termination failure for ${actor.name}`);
          }
          await observer.query(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = $1 AND backend_start::text = $2",
            [actor.session.pid, actor.session.backendStart],
          );
        } catch (error) {
          errors.push(error);
        }
      }
      const settled = await boundedSettled(actors, faults.settleMs);
      return { unsettled: settled ? [] : actors.filter((actor) => !actor.done).map((actor) => actor.name), errors };
    }

    /** What a helper has started and must release again, whichever way the call ends. */
    interface Run {
      observer: PoolClient | undefined;
      /** Everything the run started, jobs and trash. */
      actors: Actor[];
      /** The actors whose own rejection is the run's failure. */
      jobs: Actor[];
      cleanups: Array<() => Promise<void>>;
      hook: { restore: () => void } | undefined;
      timer: NodeJS.Timeout | undefined;
      /** Lets every actor the test itself holds back go on; called before settlement when the run failed. */
      releaseGates: () => void;
    }

    function newRun(): Run {
      return {
        observer: undefined,
        actors: [],
        jobs: [],
        cleanups: [],
        hook: undefined,
        timer: undefined,
        releaseGates: () => undefined,
      };
    }

    /**
     * Ends a run. A failed run first releases the gates it holds, then every actor is settled (`settleActors`). Only when
     * all have settled are the hook restored and the observer and pools released, each step on its own `try`; if one has
     * not, nothing is restored or closed under it and the file-level `abandoned` flag is set, which `beforeEach` and
     * `afterAll` honour. The error thrown keeps the original failure as its first entry and its `cause` (also a falsy
     * one): the failure that ended the run, else the rejection of the job itself.
     */
    async function finishRun(run: Run, primary: { error: unknown } | undefined, faults: Faults): Promise<void> {
      const failures: unknown[] = [];
      if (primary !== undefined) {
        try {
          run.releaseGates();
        } catch (error) {
          failures.push(error);
        }
      }
      let unsettled: string[] = [];
      if (run.observer !== undefined && run.actors.length > 0) {
        try {
          const result = await settleActors(run.observer, run.actors, faults);
          unsettled = result.unsettled;
          failures.push(...result.errors);
        } catch (error) {
          // The observation itself failed: nothing proves the actors are done.
          unsettled = run.actors.filter((actor) => !actor.done).map((actor) => actor.name);
          failures.push(error);
        }
      }
      if (run.timer !== undefined) clearTimeout(run.timer);
      const teardown = async (): Promise<unknown[]> => {
        const errors: unknown[] = [];
        try {
          run.hook?.restore();
        } catch (error) {
          errors.push(error);
        }
        for (const cleanup of [...run.cleanups].reverse()) {
          try {
            await cleanup();
          } catch (error) {
            errors.push(error);
          }
        }
        return errors;
      };
      if (unsettled.length === 0) {
        failures.push(...(await teardown()));
      } else {
        failures.push(new Error(`Owned actors not settled: ${unsettled.join(", ")}`));
        abandoned = {
          names: unsettled,
          recover: async () => {
            if (!(await boundedSettled(run.actors, faults.settleMs))) throw new Error("Owned actors still not settled");
            const errors = await teardown();
            if (errors.length > 0) throw new AggregateError(errors, "Recovering the abandoned actors failed");
            abandoned = undefined;
          },
        };
      }
      const rejected = run.jobs.map((job) => job.settled).find((outcome) => outcome?.ok === false);
      const original = primary ?? (rejected?.ok === false ? { error: rejected.error } : undefined);
      if (failures.length === 0) {
        if (primary !== undefined) throw primary.error;
        return;
      }
      if (original === undefined) throw new AggregateError(failures, "The race cleanup failed");
      throw new AggregateError([original.error, ...failures], "The race and its cleanup both failed", {
        cause: original.error,
      });
    }

    async function trashVia(trashPool: Pool, itemId: string): Promise<void> {
      const { rows } = await admin.query<{ database_id: string }>(`SELECT database_id FROM items WHERE id = $1`, [
        itemId,
      ]);
      const row = rows[0];
      if (!row) throw new Error(`Missing item ${itemId}`);
      await runInTenant(tenant, () => createChokePoint(trashPool).softDeleteItem(row.database_id, itemId));
    }

    async function hostDeletedAt(itemId: string): Promise<Date | null> {
      const { rows } = await admin.query<{ deleted_at: Date | null }>(`SELECT deleted_at FROM items WHERE id = $1`, [
        itemId,
      ]);
      return rows[0]?.deleted_at ?? null;
    }

    /** Sessions of `owned` that are still visible, by identity (pid and start time). */
    async function liveSessions(sessions: Session[]): Promise<number> {
      let live = 0;
      for (const session of sessions) {
        const { rows } = await admin.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1 AND backend_start::text = $2",
          [session.pid, session.backendStart],
        );
        live += rows[0]?.n ?? 0;
      }
      return live;
    }

    /**
     * Runs the mirror job of `parent` on a session of its own and, once the job holds the host reservation, starts a
     * trash of the host on another owned session and calls `afterTrashQueued` (with a probe for the blocked trash and a
     * `hold` that waits on a gate the helper releases on any failure). The wait for the job is bounded; everything the
     * call starts is settled on every exit before the hook is restored and the pools are closed (see `finishRun`).
     */
    async function mirrorWhileTrashing(
      parent: string,
      afterTrashQueued: (assertTrashBlockedByJob: () => Promise<void>, hold: () => Promise<void>) => Promise<void>,
      faults: Faults = faultsOf(),
    ): Promise<{ job: Settled; trash: Settled | undefined; sessions: Session[] }> {
      const run = newRun();
      const gate = gateOf();
      run.releaseGates = gate.release;
      let primary: { error: unknown } | undefined;
      let job: Actor | undefined;
      let trashActor: Actor | undefined;
      try {
        const watching = await admin.connect();
        run.observer = watching;
        run.cleanups.push(async () => watching.release());
        if (faults.failCleanup) run.cleanups.push(failingCleanup);
        const jobOwned = await ownedPool(watching);
        run.cleanups.push(() => jobOwned.pool.end());
        const trashOwned = await ownedPool(watching);
        run.cleanups.push(() => trashOwned.pool.end());
        faults.sessions.push(jobOwned.session, trashOwned.session);
        run.hook = onStatements([
          {
            match: (text, values) => /FOR UPDATE/.test(text) && values.includes(parent),
            inject: async () => {
              const queued = startActor("trash", trashOwned.session, () => trashVia(trashOwned.pool, parent));
              trashActor = queued;
              run.actors.push(queued);
              await afterTrashQueued(
                async () => {
                  // The trash is this test's own session, waiting on a lock the job's own session holds.
                  await vi.waitFor(
                    async () => {
                      const { rows } = await watching.query<{ waiting: boolean; blockers: number[] }>(
                        `SELECT wait_event_type = 'Lock' AS waiting, pg_blocking_pids(pid) AS blockers
                         FROM pg_stat_activity WHERE pid = $1 AND backend_start::text = $2`,
                        [trashOwned.session.pid, trashOwned.session.backendStart],
                      );
                      expect(rows[0]?.waiting).toBe(true);
                      expect(rows[0]?.blockers).toContain(jobOwned.session.pid);
                    },
                    { timeout: 5_000, interval: 25 },
                  );
                  expect(queued.done).toBe(false);
                  expect(await hostDeletedAt(parent)).toBeNull();
                },
                () => gate.promise,
              );
            },
          },
        ]);
        job = startActor("job", jobOwned.session, () =>
          inTenant(() => handlePageTitleMirrorTask(jobOwned.pool, { itemId: parent })),
        );
        run.actors.push(job);
        run.jobs.push(job);
        await within([job], faults.outcomeMs, "The mirror job");
      } catch (error) {
        primary = { error };
      }
      await finishRun(run, primary, faults);
      if (job === undefined) throw new Error("The job was not started");
      return {
        job: await job.outcome,
        trash: trashActor ? await trashActor.outcome : undefined,
        sessions: faults.sessions,
      };
    }

    /**
     * Runs the mirror jobs of two hosts at once, each on a session of its own, and holds each job at its host
     * reservation until both have reserved theirs (a barrier that gives up after 5 s and is released on any failure).
     * The wait for the jobs is bounded and every job is settled on every exit, with the rules of `finishRun`.
     */
    async function mirrorTwoHosts(
      hostA: string,
      hostB: string,
      faults: Faults = faultsOf(),
    ): Promise<{ a: Settled; b: Settled; sessions: Session[] }> {
      const run = newRun();
      let primary: { error: unknown } | undefined;
      try {
        const watching = await admin.connect();
        run.observer = watching;
        run.cleanups.push(async () => watching.release());
        if (faults.failCleanup) run.cleanups.push(failingCleanup);
        const ownedA = await ownedPool(watching);
        run.cleanups.push(() => ownedA.pool.end());
        const ownedB = await ownedPool(watching);
        run.cleanups.push(() => ownedB.pool.end());
        faults.sessions.push(ownedA.session, ownedB.session);
        let arrived = 0;
        let release!: () => void;
        let giveUp!: (error: Error) => void;
        const bothReserved = new Promise<void>((resolve, reject) => {
          release = resolve;
          giveUp = reject;
        });
        run.releaseGates = release;
        // The timer starts with the first arrival, so a give-up always has an arrival to deliver it to.
        const arrive = async (): Promise<void> => {
          arrived += 1;
          run.timer ??= setTimeout(() => giveUp(new Error("Only one job reserved its host within 5 s")), 5_000);
          if (arrived === 2) release();
          await bothReserved;
        };
        run.hook = onStatements(
          [hostA, hostB].map((reserved) => ({
            match: (text: string, values: readonly unknown[]) => /FOR UPDATE/.test(text) && values.includes(reserved),
            inject: arrive,
          })),
        );
        for (const [name, owned, itemId] of [
          ["jobA", ownedA, hostA],
          ["jobB", ownedB, hostB],
        ] as const) {
          const started = startActor(name, owned.session, () =>
            inTenant(() => handlePageTitleMirrorTask(owned.pool, { itemId })),
          );
          run.actors.push(started);
          run.jobs.push(started);
        }
        await within(run.jobs, faults.outcomeMs, "The mirror jobs");
      } catch (error) {
        primary = { error };
      }
      await finishRun(run, primary, faults);
      const [first, second] = run.jobs;
      if (first === undefined || second === undefined) throw new Error("The jobs were not started");
      return { a: await first.outcome, b: await second.outcome, sessions: faults.sessions };
    }

    /** A page block of `host`'s document that names `pageId` with `caption`, as a sync client could leave it. */
    async function nameFromDocument(host: string, pageId: string, caption: string): Promise<void> {
      await inTenant(async () => {
        const doc = await withTransaction(pool, (client) => getOrCreateDoc(client, host, "page"));
        await mutateDoc(pool, doc.id, "user", (ydoc) =>
          writeBlock(ydoc, { id: randomUUID(), type: "page", pageId, text: caption }),
        );
      });
    }

    it("lets two Pages hosts that name each other run at once: each locks only its own children, and mirrors them", async () => {
      const project = await host("Project of two pages");
      const a = await subpage(project, "A");
      const b = await subpage(project, "B");
      const childOfA = await subpage(a.pageItemId, "Child of A");
      const childOfB = await subpage(b.pageItemId, "Child of B");
      // Each document also names the other host, a page that is not its child (a stale or moved reference).
      await nameFromDocument(a.pageItemId, b.pageItemId, "A names B");
      await nameFromDocument(b.pageItemId, a.pageItemId, "B names A");
      await typeTitle(a.pageItemId, childOfA.blockId, "Child of A, retitled");
      await typeTitle(b.pageItemId, childOfB.blockId, "Child of B, retitled");

      const { a: jobA, b: jobB, sessions } = await mirrorTwoHosts(a.pageItemId, b.pageItemId);

      expect(jobA).toEqual({ ok: true, value: undefined });
      expect(jobB).toEqual({ ok: true, value: undefined });
      expect(await titleOf(childOfA.pageItemId)).toBe("Child of A, retitled");
      expect(await titleOf(childOfB.pageItemId)).toBe("Child of B, retitled");
      expect(await titleOf(a.pageItemId)).toBe("A");
      expect(await titleOf(b.pageItemId)).toBe("B");
      await vi.waitFor(async () => expect(await liveSessions(sessions)).toBe(0), { timeout: 5_000, interval: 25 });
    });

    it("skips a child that is moved to another parent between the job's read and its row lock", async () => {
      const parent = await host("Parent of a moving child");
      const moving = await subpage(parent, "Moving");
      const staying = await subpage(parent, "Staying");
      await typeTitle(parent, moving.blockId, "Moving, retitled");
      await typeTitle(parent, staying.blockId, "Staying, retitled");
      const hook = onStatements([
        {
          // The unlocked read of the pages the document names, not the read of the host.
          match: (text, values) =>
            /FROM items WHERE id = ANY/.test(text) && Array.isArray(values[0]) && values[0].includes(moving.pageItemId),
          inject: async () => {
            // Synthetic: no operation reparents a page; this superuser write stands in for a move after the read.
            await admin.query(
              `UPDATE items SET properties = jsonb_set(properties, '{parentItemId}', to_jsonb($2::text)) WHERE id = $1`,
              [moving.pageItemId, randomUUID()],
            );
          },
        },
      ]);
      try {
        await inTenant(() => handlePageTitleMirrorTask(pool, { itemId: parent }));
      } finally {
        hook.restore();
      }

      expect(hook.fired(0)).toBe(true);
      expect(await titleOf(moving.pageItemId)).toBe("Moving");
      expect(await titleOf(staying.pageItemId)).toBe("Staying, retitled");
    });

    it("writes nothing when the host is trashed between the job's first read and its host reservation", async () => {
      const parent = await host("Racing parent");
      const page = await subpage(parent, "Kept");
      await typeTitle(parent, page.blockId, "Changed");
      const hook = onStatements([
        { match: (text) => /FROM items WHERE id = ANY/.test(text), inject: () => trash(parent) },
      ]);
      try {
        await inTenant(() => handlePageTitleMirrorTask(pool, { itemId: parent }));
      } finally {
        hook.restore();
      }

      expect(hook.fired(0)).toBe(true);
      expect(await hostDeletedAt(parent)).not.toBeNull();
      expect(await titleOf(page.pageItemId)).toBe("Kept");
    });

    it("holds the host reservation while it writes: the trash waits on the job's own session and lands after the mirrored title", async () => {
      const parent = await host("Reserved parent");
      const page = await subpage(parent, "Kept");
      await typeTitle(parent, page.blockId, "Changed");

      const { job, trash: trashed, sessions } = await mirrorWhileTrashing(parent, (blocked) => blocked());

      expect(job).toEqual({ ok: true, value: undefined });
      expect(trashed).toEqual({ ok: true, value: undefined });
      expect(await titleOf(page.pageItemId)).toBe("Changed");
      expect(await hostDeletedAt(parent)).not.toBeNull();
      await vi.waitFor(async () => expect(await liveSessions(sessions)).toBe(0), { timeout: 5_000, interval: 25 });
    });

    it("settles the queued trash and keeps the original thrown value when the injection fails early", async () => {
      const parent = await host("Failing parent");
      const page = await subpage(parent, "Kept");
      await typeTitle(parent, page.blockId, "Changed");

      const {
        job,
        trash: trashed,
        sessions,
      } = await mirrorWhileTrashing(parent, async () => {
        // A falsy value on purpose: the failure must reach the test exactly as thrown.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 0;
      });

      expect(job).toEqual({ ok: false, error: 0 });
      expect(trashed).toEqual({ ok: true, value: undefined });
      expect(await titleOf(page.pageItemId)).toBe("Kept");
      expect(await hostDeletedAt(parent)).not.toBeNull();
      await vi.waitFor(async () => expect(await liveSessions(sessions)).toBe(0), { timeout: 5_000, interval: 25 });
    });

    it("bounds the wait for the job, releases the gate that holds it and settles the queued trash before the file goes on", async () => {
      const parent = await host("Held parent");
      const page = await subpage(parent, "Kept");
      await typeTitle(parent, page.blockId, "Changed");
      const faults = faultsOf({ outcomeMs: 300 });

      // The injection waits on the helper's own gate, so only the failure path of the bounded wait can let the job go on.
      await expect(mirrorWhileTrashing(parent, (_blocked, hold) => hold(), faults)).rejects.toThrow(
        "The mirror job did not settle within 300 ms",
      );

      expect(abandoned).toBeUndefined();
      expect(await titleOf(page.pageItemId)).toBe("Changed");
      expect(await hostDeletedAt(parent)).not.toBeNull();
      await vi.waitFor(async () => expect(await liveSessions(faults.sessions)).toBe(0), {
        timeout: 5_000,
        interval: 25,
      });
    });

    it("tries every pending actor's termination even when the first fails, and refuses to continue while one stays unsettled", async () => {
      const parent = await host("Stuck parent");
      const page = await subpage(parent, "Kept");
      await typeTitle(parent, page.blockId, "Changed");
      // The job is stuck in an injection only this test can release. The bound is wide enough for the job to reach it.
      const stuck = gateOf();
      const faults = faultsOf({ outcomeMs: 3_000, settleMs: 1_000, failTerminateFor: ["job"] });
      let failure: unknown;
      try {
        failure = await mirrorWhileTrashing(parent, () => stuck.promise, faults).then(
          () => undefined,
          (error: unknown) => error,
        );
        if (!(failure instanceof AggregateError)) throw new Error("Expected the run to fail with an AggregateError");
        const errors: unknown[] = failure.errors;
        expect(errors.map((error) => (error instanceof Error ? error.message : error))).toEqual([
          "The mirror job did not settle within 3000 ms",
          "Injected termination failure for job",
          "Owned actors not settled: job",
        ]);
        expect(failure.cause).toBe(errors[0]);
        // The failed attempt for the job did not skip the trash, whose backend was terminated and which then settled.
        expect(faults.attempted).toEqual(["job", "trash"]);
        expect(await hostDeletedAt(parent)).toBeNull();
        expect(abandoned?.names).toEqual(["job"]);
        // While an actor is unsettled, the hooks of the file refuse to reset the database or close the shared pools.
        expect(() => assertNoAbandonedActors()).toThrow("job");
      } finally {
        stuck.release();
        await abandoned?.recover();
      }

      expect(abandoned).toBeUndefined();
      expect(() => assertNoAbandonedActors()).not.toThrow();
      expect(await titleOf(page.pageItemId)).toBe("Changed");
      await vi.waitFor(async () => expect(await liveSessions(faults.sessions)).toBe(0), {
        timeout: 5_000,
        interval: 25,
      });
    });

    it("keeps the job's own falsy rejection as the first error and the cause when the cleanup fails as well", async () => {
      const parent = await host("Failing cleanup parent");
      const page = await subpage(parent, "Kept");
      await typeTitle(parent, page.blockId, "Changed");
      const faults = faultsOf({ failCleanup: true });

      const failure = await mirrorWhileTrashing(
        parent,
        async () => {
          // A falsy value on purpose: it must stay the first error of the failure and its cause.
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 0;
        },
        faults,
      ).then(
        () => undefined,
        (error: unknown) => error,
      );

      if (!(failure instanceof AggregateError)) throw new Error("Expected the run to fail with an AggregateError");
      const errors: unknown[] = failure.errors;
      expect(errors[0]).toBe(0);
      expect(failure.cause).toBe(0);
      expect(errors.slice(1).map((error) => (error instanceof Error ? error.message : error))).toEqual([
        "Injected cleanup failure",
      ]);
      // The step that failed did not stop the other cleanups: the sessions are gone, the trash settled.
      expect(abandoned).toBeUndefined();
      expect(await titleOf(page.pageItemId)).toBe("Kept");
      expect(await hostDeletedAt(parent)).not.toBeNull();
      await vi.waitFor(async () => expect(await liveSessions(faults.sessions)).toBe(0), {
        timeout: 5_000,
        interval: 25,
      });
    });
  });

  it("refuses a payload with an extra key or a non-UUID item id", async () => {
    await expect(handlePageTitleMirrorTask(pool, { itemId: "nope" })).rejects.toThrow();
    await expect(handlePageTitleMirrorTask(pool, { itemId: randomUUID(), extra: true })).rejects.toThrow();
  });
});
