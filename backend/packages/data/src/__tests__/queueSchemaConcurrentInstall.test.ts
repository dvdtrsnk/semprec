import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import pg, { type Pool } from "pg";
import { runAsSystem } from "@semprec/shared";
import { createPool } from "../db/pool.js";
import { installQueueSchema } from "../db/queueSchema.js";

/** Queue runtimes that start together on one fresh database, as semprec-api, -agents and -transcribe do. */
const PROCESSES = 6;
/** Fresh databases tried; without the grant lock, every one of them has seen at least one refused grant. */
const ROUNDS = 5;
const TEST_TIMEOUT_MS = 120_000;
const RLS_TABLES = ["_private_job_queues", "_private_jobs", "_private_known_crontabs", "_private_tasks"];

function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set — is vitest.config.ts's globalSetup wired up?");
  return url;
}

/** An empty database of its own, so graphile-worker's schema does not exist before the test installs it. */
async function withEmptyDatabase(fn: (url: string) => Promise<void>): Promise<void> {
  // The name is a fixed prefix and a UUID's hex digits, so the interpolation below cannot break out of the quotes.
  const name = `queue_schema_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: testDatabaseUrl() });
  try {
    await admin.query(`CREATE DATABASE "${name}" ENCODING 'UTF8' TEMPLATE template0`);
  } catch (createError) {
    try {
      await admin.end();
    } catch {
      // The CREATE DATABASE rejection is the real failure; a failed pool teardown must not replace it.
    }
    throw createError;
  }
  const url = new URL(testDatabaseUrl());
  url.pathname = `/${name}`;
  let failure: { error: unknown } | undefined;
  try {
    await fn(url.toString());
  } catch (error) {
    failure = { error };
  }
  const cleanup = [() => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`), () => admin.end()];
  for (const step of cleanup) {
    try {
      await step();
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}

/** One pool per process, each ended whatever `fn` did. */
async function withProcessPools(url: string, fn: (pools: Pool[]) => Promise<void>): Promise<void> {
  const pools = Array.from({ length: PROCESSES }, () => createPool(url));
  let failure: { error: unknown } | undefined;
  try {
    await fn(pools);
  } catch (error) {
    failure = { error };
  }
  for (const pool of pools) {
    try {
      await pool.end();
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}

describe("installQueueSchema", () => {
  it(
    "succeeds in every process that runs it at once on a fresh database, and leaves semprec_side its grants and policies",
    async () => {
      for (let round = 0; round < ROUNDS; round++) {
        await withEmptyDatabase((url) =>
          withProcessPools(url, async (pools) => {
            const outcomes = await Promise.allSettled(pools.map((pool) => installQueueSchema(pool)));
            expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([]);

            const [pool] = pools;
            if (!pool) throw new Error("no process pool");
            const state = await runAsSystem("queue schema check", () =>
              pool.query<{ usage: boolean; jobsInsert: boolean; executeAddJob: boolean; policies: string[] }>(
                `SELECT has_schema_privilege('semprec_side', 'graphile_worker', 'USAGE') AS usage,
                        has_table_privilege('semprec_side', 'graphile_worker._private_jobs', 'INSERT') AS "jobsInsert",
                        has_function_privilege('semprec_side', 'graphile_worker.add_job(text, json, text, timestamptz, integer, text, integer, text[], text)', 'EXECUTE') AS "executeAddJob",
                        ARRAY(SELECT tablename::text FROM pg_policies
                              WHERE schemaname = 'graphile_worker' AND policyname = 'semprec_side_all'
                              ORDER BY tablename) AS policies`,
              ),
            );
            expect(state.rows).toEqual([{ usage: true, jobsInsert: true, executeAddJob: true, policies: RLS_TABLES }]);
          }),
        );
      }
    },
    TEST_TIMEOUT_MS,
  );
});
