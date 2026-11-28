import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { CORE_TASK_NAMES, enqueueJob } from "@alldots/queue";
import { runInTenant } from "@alldots/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../db/pool.js";
import { enqueueMailAccountSync, enqueuePostSendMailSyncs } from "../mail/mailSyncEnqueue.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;

/** The due jobs in the order graphile-worker takes them: priority, then due time, then id. */
async function dueOrder(): Promise<string[]> {
  const { rows } = await admin.query<{ task_identifier: string }>(
    `SELECT task_identifier FROM graphile_worker.jobs WHERE run_at <= now() + interval '2 minutes'
      ORDER BY priority, run_at, id`,
  );
  return rows.map((row) => row.task_identifier);
}

describe("mail sync jobs ahead of a backlog", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "alldots_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  it.each([
    { trigger: "an IDLE signal or a follow-up", enqueue: enqueueMailAccountSync },
    { trigger: "a send", enqueue: enqueuePostSendMailSyncs },
  ])("are taken before older default-priority jobs when $trigger enqueues one", ({ enqueue }) =>
    runInTenant(tenant, async () => {
      await withTransaction(runtime, async (client) => {
        for (let index = 0; index < 3; index++)
          await enqueueJob(client, CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE, { itemId: randomUUID() });
      });
      await withTransaction(runtime, (client) => enqueue(client, randomUUID()));

      const order = await dueOrder();
      expect(order[0]).toBe(CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC);
      expect(order.filter((task) => task === CORE_TASK_NAMES.VALUE_LINKS_PROPAGATE)).toHaveLength(3);
    }),
  );
});
