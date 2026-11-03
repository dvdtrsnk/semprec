import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import { countJobsByIdentifier } from "@semprec/queue/testSupport";
import { runInTenant } from "@semprec/shared";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { databaseArchiveWithClient } from "../chokePoint/databaseOps.js";
import { requireRollupCoordinationTransaction } from "../chokePoint/databaseRowLocks.js";
import { withTransaction } from "../db/pool.js";
import { upsertRollupDependency } from "../rollup/dependencies.js";
import { createActionRegistry } from "../scheduler/actions.js";
import { createRuntimeRolePool, getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createCoreTaskList } from "../worker.js";

let admin: Pool;

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("rollup coordination barrier timed out")), 5000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Observes one production statement on its actual client; the holder pauses after it succeeds. */
function observe(
  pool: Pool,
  matches: (text: string, values: unknown) => boolean,
  hold: boolean,
  failureAfterRelease?: { error: unknown },
) {
  let resolvePid!: (pid: number) => void;
  const pid = new Promise<number>((resolve) => {
    resolvePid = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const originals = new Map<PoolClient, PoolClient["query"]>();
  let captured = false;
  const instrument = (client: PoolClient) => {
    if (originals.has(client)) return;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    originals.set(client, client.query);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    client.query = new Proxy(client.query, {
      apply(target, receiver, args: unknown[]) {
        if (captured || typeof args[0] !== "string" || !matches(args[0], args[1])) {
          return Reflect.apply(target, receiver, args);
        }
        captured = true;
        return (async () => {
          await client.query("SELECT set_config('lock_timeout', $1, true)", ["5s"]);
          const backend = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
          if (backend === undefined) throw new Error("Missing observed backend PID");
          if (!hold) {
            resolvePid(backend);
            return Reflect.apply(target, receiver, args);
          }
          const result: unknown = await Reflect.apply(target, receiver, args);
          resolvePid(backend);
          await gate;
          if (failureAfterRelease) throw failureAfterRelease.error;
          return result;
        })();
      },
    });
  };
  pool.on("acquire", instrument);
  return {
    pid,
    release,
    restore() {
      pool.off("acquire", instrument);
      for (const [client, query] of originals) client.query = query;
    },
  };
}

describe("rollup source archive coordination", () => {
  beforeEach(async () => {
    admin ??= getTestPool();
    await resetDatabase(admin);
  });
  afterAll(async () => {
    await admin?.end();
  });

  it.each([
    ["create", "archive", "config-first"],
    ["create", "archive", "database-first"],
    ["update", "restore", "config-first"],
    ["update", "restore", "database-first"],
  ] as const)(
    "coordinates %s and %s when %s acquires the source row first",
    async (operation, lifecycle, order) => {
      const pools: Pool[] = [];
      const tenant = getTenantZeroId();
      const scoped = <T>(fn: () => Promise<T>) => runInTenant(tenant, fn);
      const owned: Array<Promise<PromiseSettledResult<unknown>[]>> = [];
      let holder: ReturnType<typeof observe> | undefined;
      let waiter: ReturnType<typeof observe> | undefined;
      let failure: { error: unknown } | undefined;
      try {
        const configPool = await createRuntimeRolePool(admin, "semprec_data");
        pools.push(configPool);
        const databasePool = await createRuntimeRolePool(admin, "semprec_data");
        pools.push(databasePool);
        const workerPool = await createRuntimeRolePool(admin, "semprec_data");
        pools.push(workerPool);
        const configCp = createChokePoint(configPool);
        const databaseCp = createChokePoint(databasePool);
        const parents = await scoped(() => configCp.createDatabase({ name: "Parents" }));
        const source = await scoped(() => configCp.createDatabase({ name: "Source" }));
        await scoped(() =>
          configCp.createProperty({ databaseId: source.id, key: "hours", name: "Hours", type: "number" }),
        );
        const { property: relation } = await scoped(() =>
          configCp.createRelationProperty({
            sourceDatabaseId: parents.id,
            targetDatabaseId: source.id,
            key: "children",
            name: "Children",
          }),
        );
        await scoped(() =>
          configCp.createProperty({
            databaseId: parents.id,
            key: "total",
            name: "Total",
            type: "rollup",
            config: { relationPropertyKey: "children", aggregation: "sum", targetPropertyKey: "hours" },
          }),
        );
        const parent = await scoped(() => configCp.createItem({ databaseId: parents.id, properties: {} }));
        const child = await scoped(() => configCp.createItem({ databaseId: source.id, properties: { hours: 7 } }));
        await scoped(() =>
          configCp.createRelation({ relationPropertyId: relation.id, callerItemId: parent.id, targetItemId: child.id }),
        );
        const drain = async () => {
          for (let pass = 0; pass < 10; pass++) {
            const work = runOnce({
              pgPool: workerPool,
              taskList: createCoreTaskList(workerPool, createActionRegistry()),
            });
            owned.push(Promise.allSettled([work]));
            await bounded(work);
            const pending = await Promise.all(
              [CORE_TASK_NAMES.ROLLUP_RECOMPUTE_FULL, CORE_TASK_NAMES.ROLLUP_RECOMPUTE].map((name) =>
                countJobsByIdentifier(admin, name),
              ),
            );
            if (pending.every((count) => count === 0)) return;
          }
          throw new Error("Rollup queue did not drain");
        };
        let countId: string | undefined;
        if (operation === "update") {
          const formerSource = await scoped(() => configCp.createDatabase({ name: "Former source" }));
          await scoped(() =>
            configCp.createRelationProperty({
              sourceDatabaseId: parents.id,
              targetDatabaseId: formerSource.id,
              key: "formerChildren",
              name: "Former children",
            }),
          );
          countId = (
            await scoped(() =>
              configCp.createProperty({
                databaseId: parents.id,
                key: "childCount",
                name: "Count",
                type: "rollup",
                config: { relationPropertyKey: "formerChildren", aggregation: "count" },
              }),
            )
          ).id;
        }
        await drain();
        if (lifecycle === "restore") {
          await scoped(() => databaseCp.archiveDatabase(source.id));
          await drain();
        }
        const isSource = (values: unknown) => Array.isArray(values) && values[0] === source.id;
        const configMatch = (text: string, values: unknown) => text.includes("FOR SHARE") && isSource(values);
        const databaseMatch = (text: string, values: unknown) =>
          text.includes("UPDATE databases SET archived_at") && isSource(values);
        holder = observe(
          order === "config-first" ? configPool : databasePool,
          order === "config-first" ? configMatch : databaseMatch,
          true,
        );
        waiter = observe(
          order === "config-first" ? databasePool : configPool,
          order === "config-first" ? databaseMatch : configMatch,
          false,
        );
        const configure = () =>
          scoped(() => {
            if (operation === "create")
              return configCp.createProperty({
                databaseId: parents.id,
                key: "childCount",
                name: "Count",
                type: "rollup",
                config: { relationPropertyKey: "children", aggregation: "count" },
              });
            if (!countId) throw new Error("Missing rollup property");
            return configCp.updatePropertyConfig(countId, { relationPropertyKey: "children", aggregation: "count" });
          });
        const changeDatabase = () =>
          scoped(() =>
            lifecycle === "archive" ? databaseCp.archiveDatabase(source.id) : databaseCp.restoreDatabase(source.id),
          );
        const first: Promise<unknown> = order === "config-first" ? configure() : changeDatabase();
        owned.push(Promise.allSettled([first]));
        const holderPid = await bounded(holder.pid);
        const second: Promise<unknown> = order === "config-first" ? changeDatabase() : configure();
        owned.push(Promise.allSettled([second]));
        const waiterPid = await bounded(waiter.pid);
        let blocked = false;
        for (let attempt = 0; attempt < 200 && !blocked; attempt++) {
          const result = await admin.query<{ blocked: boolean }>(
            "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
            [holderPid, waiterPid],
          );
          blocked = result.rows[0]?.blocked === true;
          if (!blocked) await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        const waiting = await admin.query<{ query: string; wait_event_type: string | null }>(
          "SELECT query, wait_event_type FROM pg_stat_activity WHERE pid = $1",
          [waiterPid],
        );
        expect(waiting.rows[0]?.wait_event_type).toBe("Lock");
        expect(waiting.rows[0]?.query).toContain(
          order === "config-first" ? "UPDATE databases SET archived_at" : "FOR SHARE",
        );
        const transactionLock = await admin.query<{ matched: boolean }>(
          `SELECT EXISTS (
           SELECT 1 FROM pg_locks waiting
           JOIN pg_locks holding ON holding.locktype = waiting.locktype
             AND holding.transactionid = waiting.transactionid
          WHERE waiting.pid = $1 AND holding.pid = $2
            AND waiting.locktype = 'transactionid' AND NOT waiting.granted AND holding.granted
         ) AS matched`,
          [waiterPid, holderPid],
        );
        expect(transactionLock.rows[0]?.matched).toBe(true);
        holder.release();
        await bounded(first);
        await bounded(second);
        await drain();
        const current = await scoped(() => configCp.getItem(parents.id, parent.id));
        expect(current?.computed).toMatchObject(
          lifecycle === "archive" ? { childCount: 0, total: null } : { childCount: 1, total: 7 },
        );
        const countProperty = (await scoped(() => configCp.listProperties(parents.id))).find(
          (property) => property.key === "childCount",
        );
        if (!countProperty) throw new Error("Missing count rollup");
        const dependency = await scoped(() =>
          withTransaction(configPool, (client) =>
            client.query<{ source_database_id: string }>(
              "SELECT source_database_id FROM rollup_dependencies WHERE rollup_property_id = $1",
              [countProperty.id],
            ),
          ),
        );
        expect(dependency.rows).toEqual([{ source_database_id: source.id }]);
      } catch (error) {
        failure = { error };
      } finally {
        holder?.release();
        waiter?.release();
        const outcomes = (await Promise.all(owned)).flat();
        holder?.restore();
        waiter?.restore();
        const closed = await Promise.allSettled(pools.map((pool) => pool.end()));
        const secondary = [...outcomes, ...closed]
          .filter((result) => result.status === "rejected")
          .map((result) => result.reason);
        if (secondary.length)
          failure = { error: new AggregateError(failure ? [failure.error, ...secondary] : secondary) };
      }
      if (failure) throw failure.error;
    },
    30000,
  );

  it("releases the source lock on configuration rollback without a dependency or job", async () => {
    const pools: Pool[] = [];
    const tenant = getTenantZeroId();
    const scoped = <T>(fn: () => Promise<T>) => runInTenant(tenant, fn);
    const marker = new Error("injected rollback after source lock");
    let creationSettled: Promise<PromiseSettledResult<unknown>[]> | undefined;
    let archiveSettled: Promise<PromiseSettledResult<unknown>[]> | undefined;
    let holder: ReturnType<typeof observe> | undefined;
    let waiter: ReturnType<typeof observe> | undefined;
    let failure: { error: unknown } | undefined;
    try {
      const configPool = await createRuntimeRolePool(admin, "semprec_data");
      pools.push(configPool);
      const archivePool = await createRuntimeRolePool(admin, "semprec_data");
      pools.push(archivePool);
      const configCp = createChokePoint(configPool);
      const archiveCp = createChokePoint(archivePool);
      const parents = await scoped(() => configCp.createDatabase({ name: "Rollback parents" }));
      const source = await scoped(() => configCp.createDatabase({ name: "Rollback source" }));
      await scoped(() =>
        configCp.createRelationProperty({
          sourceDatabaseId: parents.id,
          targetDatabaseId: source.id,
          key: "children",
          name: "Children",
        }),
      );
      const isSource = (values: unknown) => Array.isArray(values) && values[0] === source.id;
      holder = observe(configPool, (text, values) => text.includes("FOR SHARE") && isSource(values), true, {
        error: marker,
      });
      waiter = observe(
        archivePool,
        (text, values) => text.includes("UPDATE databases SET archived_at") && isSource(values),
        false,
      );
      const creation = scoped(() =>
        configCp.createProperty({
          databaseId: parents.id,
          key: "childCount",
          name: "Count",
          type: "rollup",
          config: { relationPropertyKey: "children", aggregation: "count" },
        }),
      );
      creationSettled = Promise.allSettled([creation]);
      const holderPid = await bounded(holder.pid);
      const archive = scoped(() => archiveCp.archiveDatabase(source.id));
      archiveSettled = Promise.allSettled([archive]);
      const waiterPid = await bounded(waiter.pid);
      let blocked = false;
      for (let attempt = 0; attempt < 200 && !blocked; attempt++) {
        const result = await admin.query<{ blocked: boolean }>(
          "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
          [holderPid, waiterPid],
        );
        blocked = result.rows[0]?.blocked === true;
        if (!blocked) await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      holder.release();
      await expect(bounded(creation)).rejects.toBe(marker);
      await bounded(archive);
      expect(
        (await scoped(() => configCp.listProperties(parents.id))).some((property) => property.key === "childCount"),
      ).toBe(false);
      expect(await countJobsByIdentifier(admin, CORE_TASK_NAMES.ROLLUP_RECOMPUTE_FULL)).toBe(0);
      expect((await scoped(() => archiveCp.getDatabase(source.id)))?.archivedAt).not.toBeNull();
    } catch (error) {
      failure = { error };
    } finally {
      holder?.release();
      waiter?.release();
      const [creationResult] = creationSettled ? await creationSettled : [];
      const [archiveResult] = archiveSettled ? await archiveSettled : [];
      holder?.restore();
      waiter?.restore();
      const closed = await Promise.allSettled(pools.map((pool) => pool.end()));
      const secondary: unknown[] = [];
      if (creationResult?.status === "rejected" && creationResult.reason !== marker)
        secondary.push(creationResult.reason);
      if (archiveResult?.status === "rejected") secondary.push(archiveResult.reason);
      for (const result of closed) if (result.status === "rejected") secondary.push(result.reason);
      if (secondary.length)
        failure = { error: new AggregateError(failure ? [failure.error, ...secondary] : secondary) };
    }
    if (failure) throw failure.error;
  }, 30000);

  it("rejects unmanaged and non-READ-COMMITTED supplied clients before protected writes", async () => {
    const runtime = await createRuntimeRolePool(admin, "semprec_data");
    let failure: { error: unknown } | undefined;
    try {
      const cp = createChokePoint(runtime);
      const tenant = getTenantZeroId();
      const database = await runInTenant(tenant, () => cp.createDatabase({ name: "Guarded" }));
      const input = {
        rollupPropertyId: randomUUID(),
        relationDefinitionId: randomUUID(),
        sourceDatabaseId: database.id,
        sourcePropertyKey: null,
      };
      const client = await runtime.connect();
      let clientFailure: { error: unknown } | undefined;
      try {
        await expect(databaseArchiveWithClient(client, database.id)).rejects.toThrow(/active managed transaction/);
        await expect(upsertRollupDependency(client, input)).rejects.toThrow(/active managed transaction/);
        await runInTenant(tenant, () =>
          withTransaction(runtime, async () => {
            await expect(databaseArchiveWithClient(client, database.id)).rejects.toThrow(/active managed transaction/);
            await expect(upsertRollupDependency(client, input)).rejects.toThrow(/active managed transaction/);
          }),
        );
      } catch (error) {
        clientFailure = { error };
      }
      const [released] = await Promise.allSettled([Promise.resolve().then(() => client.release())]);
      if (clientFailure && released?.status === "rejected")
        throw new AggregateError([clientFailure.error, released.reason]);
      if (clientFailure) throw clientFailure.error;
      if (released?.status === "rejected") throw released.reason;
      for (const isolation of ["repeatable_read", "serializable"] as const) {
        await expect(
          runInTenant(tenant, () =>
            withTransaction(runtime, (tx) => databaseArchiveWithClient(tx, database.id), { isolation }),
          ),
        ).rejects.toThrow(/READ COMMITTED/);
        await expect(
          runInTenant(tenant, () => withTransaction(runtime, (tx) => upsertRollupDependency(tx, input), { isolation })),
        ).rejects.toThrow(/READ COMMITTED/);
      }
      let original: { error: unknown } | undefined;
      const [aborted] = await Promise.allSettled([
        runInTenant(tenant, () =>
          withTransaction(runtime, async (tx) => {
            try {
              await tx.query("SELECT 1 / 0");
            } catch (error) {
              original = { error };
            }
            if (!original) throw new Error("Expected PostgreSQL failure");
            // The queued probe waits for the previous ReadyForQuery before it runs.
            await expect(tx.query("SELECT 1")).rejects.toMatchObject({ code: "25P02" });
            expect(tx.getTransactionStatus()).toBe("E");
            await expect(requireRollupCoordinationTransaction(tx)).rejects.toThrow(/active READ COMMITTED transaction/);
            throw original.error;
          }),
        ),
      ]);
      expect(aborted?.status).toBe("rejected");
      if (aborted?.status !== "rejected" || !original) throw new Error("Expected rolled-back failure");
      expect(aborted.reason).toBe(original.error);
      expect((await runInTenant(tenant, () => cp.getDatabase(database.id)))?.archivedAt).toBeNull();
      expect(await countJobsByIdentifier(admin, CORE_TASK_NAMES.ROLLUP_RECOMPUTE_FULL)).toBe(0);
    } catch (error) {
      failure = { error };
    }
    const [closed] = await Promise.allSettled([runtime.end()]);
    if (failure && closed?.status === "rejected") throw new AggregateError([failure.error, closed.reason]);
    if (failure) throw failure.error;
    if (closed?.status === "rejected") throw closed.reason;
  });

  it("preserves the existing foreign-key failure and dependency on a missing source", async () => {
    const runtime = await createRuntimeRolePool(admin, "semprec_data");
    let failure: { error: unknown } | undefined;
    try {
      const tenant = getTenantZeroId();
      const cp = createChokePoint(runtime);
      await runInTenant(tenant, async () => {
        const parents = await cp.createDatabase({ name: "Parents" });
        const source = await cp.createDatabase({ name: "Source" });
        await cp.createRelationProperty({
          sourceDatabaseId: parents.id,
          targetDatabaseId: source.id,
          key: "children",
          name: "Children",
        });
        const rollup = await cp.createProperty({
          databaseId: parents.id,
          key: "childCount",
          name: "Count",
          type: "rollup",
          config: { relationPropertyKey: "children", aggregation: "count" },
        });
        const read = () =>
          withTransaction(runtime, (client) =>
            client.query<{ relation_definition_id: string; source_database_id: string }>(
              "SELECT relation_definition_id, source_database_id FROM rollup_dependencies WHERE rollup_property_id = $1",
              [rollup.id],
            ),
          );
        const before = (await read()).rows[0];
        if (!before) throw new Error("Missing dependency");
        await expect(
          withTransaction(runtime, (client) =>
            upsertRollupDependency(client, {
              rollupPropertyId: rollup.id,
              relationDefinitionId: before.relation_definition_id,
              sourceDatabaseId: randomUUID(),
              sourcePropertyKey: null,
            }),
          ),
        ).rejects.toMatchObject({ code: "23503" });
        expect((await read()).rows).toEqual([before]);
      });
    } catch (error) {
      failure = { error };
    }
    const [closed] = await Promise.allSettled([runtime.end()]);
    if (failure && closed?.status === "rejected") throw new AggregateError([failure.error, closed.reason]);
    if (failure) throw failure.error;
    if (closed?.status === "rejected") throw closed.reason;
  });
});
