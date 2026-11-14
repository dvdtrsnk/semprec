import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { runInTenant, type SempMessageRef } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import {
  createChokePoint,
  getDatabaseByModuleId,
  seedSystem,
  sendSempMessage,
  validateSempMessageRefs,
  withTransaction,
} from "../index.js";

describe("Semp reference observation", () => {
  let admin: Pool;
  let runtime: Pool;
  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  it("issues one real observation statement per nonempty reference kind", async () => {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime));
    const makeRefs = (): SempMessageRef[] => [
      { kind: "item", itemId: randomUUID(), databaseId: randomUUID() },
      { kind: "transcriptSegment", itemId: randomUUID(), startsAt: 0, endsAt: 1 },
      { kind: "block", itemId: randomUUID(), blockId: randomUUID() },
      { kind: "mailAttachment", attachmentId: randomUUID() },
      { kind: "mailThread", threadId: randomUUID() },
      { kind: "agentRun", agentRunId: randomUUID() },
      { kind: "approvalRequest", approvalRequestId: randomUUID() },
      { kind: "taskTrace", itemId: randomUUID(), databaseId: randomUUID(), traceDay: "2026-11-02" },
      { kind: "taskOccurrence", seriesId: randomUUID(), occurrenceDate: "2026-11-16" },
    ];
    await runInTenant(tenant, () =>
      withTransaction(runtime, async (client) => {
        const queries: string[] = [];
        const original = Object.getOwnPropertyDescriptor(client, "query");
        /* eslint-disable @typescript-eslint/unbound-method */
        client.query = new Proxy(client.query, {
          apply(target, receiver, args: unknown[]) {
            if (typeof args[0] === "string") queries.push(args[0]);
            return Reflect.apply(target, receiver, args);
          },
        });
        /* eslint-enable @typescript-eslint/unbound-method */
        try {
          await expect(validateSempMessageRefs(client, [...makeRefs(), ...makeRefs()])).rejects.toMatchObject({
            code: "validation_failed",
            details: { field: "context[0]" },
          });
        } finally {
          if (original) Object.defineProperty(client, "query", original);
          else Reflect.deleteProperty(client, "query");
        }
        expect(queries).toHaveLength(9);
        for (const fragment of [
          "JOIN items i ON i.id = r.item_id AND i.database_id",
          "i.computed -> 'segments' AS segments",
          "SELECT d.id, d.item_id FROM docs d",
          "JOIN mail_attachments t",
          "LEFT JOIN mail_thread_aliases a ON",
          "JOIN agent_runs t",
          "JOIN approval_requests t",
          "JOIN items t ON t.id = r.item_id AND t.database_id",
          "JOIN task_recurrence t ON t.series_id = r.series_id",
        ]) {
          expect(queries.filter((sql) => sql.includes(fragment))).toHaveLength(1);
        }
      }),
    );
  });

  it("accepts a sleep night ref without any statement, keeps the first of equal nights and still refuses a missing neighbour by its own index", async () => {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime));
    const night = (value: string): SempMessageRef => ({ kind: "sleepNight", night: value });
    const queries: string[] = [];
    let validationStatements: string[] = [];
    const accepted = await runInTenant(tenant, () =>
      withTransaction(runtime, async (client) => {
        /* eslint-disable @typescript-eslint/unbound-method */
        client.query = new Proxy(client.query, {
          apply(target, receiver, args: unknown[]) {
            if (typeof args[0] === "string") queries.push(args[0]);
            return Reflect.apply(target, receiver, args);
          },
        });
        /* eslint-enable @typescript-eslint/unbound-method */
        const result = await validateSempMessageRefs(client, [
          night("2026-10-16"),
          night("2026-10-17"),
          night("2026-10-16"),
        ]);
        validationStatements = [...queries];
        return result;
      }),
    );
    expect(accepted).toEqual([night("2026-10-16"), night("2026-10-17")]);
    expect(validationStatements).toEqual([]);

    await expect(
      runInTenant(tenant, () =>
        withTransaction(runtime, (client) =>
          validateSempMessageRefs(client, [night("2026-10-16"), { kind: "agentRun", agentRunId: randomUUID() }]),
        ),
      ),
    ).rejects.toMatchObject({ code: "validation_failed", details: { field: "context[1]" } });
  });

  it("refuses deletion before observation and permits deletion after observation", async () => {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime));
    const taskDb = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) => getDatabaseByModuleId(client, "tasks")),
    );
    if (!taskDb) throw new Error("Missing tasks database");
    const cp = createChokePoint(runtime);
    const first = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: taskDb.id, properties: { name: "First" } }),
    );
    const second = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: taskDb.id, properties: { name: "Second" } }),
    );
    const purge = (id: string) =>
      runInTenant(tenant, async () => {
        await cp.softDeleteItem(taskDb.id, id);
        const result = await cp.purgeExpiredTrashSubtree(id, new Date("9999-01-01T00:00:00Z"));
        expect(result.purgedItemIds).toContain(id);
      });
    await purge(first.id);
    await expect(
      runInTenant(tenant, () =>
        withTransaction(runtime, (client) =>
          validateSempMessageRefs(client, [{ kind: "item", itemId: first.id, databaseId: taskDb.id }]),
        ),
      ),
    ).rejects.toMatchObject({ code: "validation_failed", details: { field: "context[0]" } });

    let observed!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = runInTenant(tenant, () =>
      withTransaction(runtime, async (client) => {
        const context = await validateSempMessageRefs(client, [
          { kind: "item", itemId: second.id, databaseId: taskDb.id },
        ]);
        observed();
        await proceed;
        return sendSempMessage(client, { text: "question", context, hasContext: true });
      }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failure: unknown;
    let failed = false;
    try {
      await Promise.race([
        ready,
        operation.then(() => {
          throw new Error("Send completed before observation barrier");
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Observation timed out")), 10_000);
        }),
      ]);
      await purge(second.id);
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      if (timer) clearTimeout(timer);
      release();
    }
    const settled = await Promise.allSettled([operation]);
    const result = settled[0];
    if (failed) {
      if (result?.status === "rejected")
        throw new AggregateError([failure, result.reason], "Observation and send failed");
      throw failure instanceof Error ? failure : new Error("Observation failed", { cause: failure });
    }
    if (!result) throw new Error("Missing send result");
    if (result.status === "rejected")
      throw result.reason instanceof Error ? result.reason : new Error("Send failed", { cause: result.reason });
    const row = await runInTenant(tenant, () =>
      runtime.query<{ context: unknown }>("SELECT context FROM semp_messages WHERE id = $1", [result.value.messageId]),
    );
    expect(row.rows).toEqual([{ context: [{ kind: "item", itemId: second.id, databaseId: taskDb.id }] }]);
  });
});
