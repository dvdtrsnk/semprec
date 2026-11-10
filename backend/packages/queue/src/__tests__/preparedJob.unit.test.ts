import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runAsSystem, runInTenant, withTraceContext } from "@semprec/shared";
import {
  addPreparedJob,
  assertSearchTaskIdentifiersRegistered,
  CORE_TASK_NAMES,
  enqueueJob,
  prepareJob,
  queueJobEnvelopeSchema,
  SEARCH_TASK_IDENTIFIERS,
  SearchTaskIdentifiersNotRegisteredError,
  type PreparedJob,
} from "../index.js";

const TENANT = randomUUID();
const OTHER = randomUUID();
const TRACE = randomUUID();

function fakeClient(rows: Record<string, unknown>[] = []) {
  return { query: vi.fn().mockResolvedValue({ rows }) };
}

const addJobValues = z.tuple([
  z.string(),
  z.string(),
  z.string().nullable(),
  z.date().nullable(),
  z.number().nullable(),
  z.string().nullable(),
  z.string(),
  z.number(),
]);

/** The bound values of the one `add_job` call the fake client received. */
function sentValues(client: ReturnType<typeof fakeClient>) {
  expect(client.query).toHaveBeenCalledTimes(1);
  const [sql, values] = z.tuple([z.string(), z.unknown()]).parse(client.query.mock.calls[0]);
  expect(sql).toContain("graphile_worker.add_job");
  return addJobValues.parse(values);
}

describe("prepareJob and addPreparedJob (R1 D1)", () => {
  it("adds the call exactly as it was prepared, whatever the scope, trace or caller does afterwards", async () => {
    const runAt = new Date("2026-11-08T10:00:00.000Z");
    const payload: Record<string, unknown> = { itemId: "a" };
    const job = await runInTenant(TENANT, () =>
      withTraceContext({ traceId: TRACE }, async () =>
        prepareJob(CORE_TASK_NAMES.ITEM_SEARCH_PAGE_TEXT, payload, {
          jobKey: "item-a",
          jobKeyMode: "preserve_run_at",
          runAt,
          queueName: "item-search-index:lane",
          maxAttempts: 3,
          priority: 2,
        }),
      ),
    );
    payload.itemId = "b";
    runAt.setTime(0);
    const client = fakeClient();
    await runInTenant(OTHER, () =>
      withTraceContext({ traceId: randomUUID() }, () => addPreparedJob(client as never, job)),
    );
    const [identifier, envelopeJson, queueName, sentRunAt, maxAttempts, jobKey, jobKeyMode, priority] =
      sentValues(client);
    expect({ identifier, queueName, maxAttempts, jobKey, jobKeyMode, priority }).toEqual({
      identifier: CORE_TASK_NAMES.ITEM_SEARCH_PAGE_TEXT,
      queueName: "item-search-index:lane",
      maxAttempts: 3,
      jobKey: "item-a",
      jobKeyMode: "preserve_run_at",
      priority: 2,
    });
    expect(sentRunAt?.toISOString()).toBe("2026-11-08T10:00:00.000Z");
    expect(queueJobEnvelopeSchema.parse(JSON.parse(envelopeJson))).toEqual({
      traceId: TRACE,
      tenantId: TENANT,
      payload: { itemId: "a" },
    });
    expect(job).toEqual({ identifier: CORE_TASK_NAMES.ITEM_SEARCH_PAGE_TEXT, jobKey: "item-a", tenantId: TENANT });
    expect(Object.isFrozen(job)).toBe(true);
  });

  it("defaults to replace mode with no queue, run time or attempts, and stamps a system job's tenant as null", async () => {
    const job = await runAsSystem("test", async () => prepareJob("someTask", {}, { jobKey: "k" }));
    const client = fakeClient();
    await addPreparedJob(client as never, job);
    const [, envelopeJson, queueName, runAt, maxAttempts, , jobKeyMode, priority] = sentValues(client);
    expect({ queueName, runAt, maxAttempts, jobKeyMode, priority }).toEqual({
      queueName: null,
      runAt: null,
      maxAttempts: null,
      jobKeyMode: "replace",
      priority: 0,
    });
    expect(queueJobEnvelopeSchema.parse(JSON.parse(envelopeJson)).tenantId).toBeNull();
    expect(job.tenantId).toBeNull();
  });

  it("refuses a handle prepareJob did not return before any query", async () => {
    const lookalike: PreparedJob = { identifier: "someTask", jobKey: "k", tenantId: null };
    const client = fakeClient();
    await expect(addPreparedJob(client as never, lookalike)).rejects.toThrow(TypeError);
    expect(client.query).not.toHaveBeenCalled();
  });

  it.each([
    ["no key", {}],
    ["an empty key", { jobKey: "" }],
    ["unsafe_dedupe", { jobKey: "k", jobKeyMode: "unsafe_dedupe" }],
    ["an invalid run time", { jobKey: "k", runAt: new Date(Number.NaN) }],
    ["an unknown option", { jobKey: "k", flags: ["x"] }],
  ])("refuses options with %s", (_case, options) => {
    expect(() => runAsSystem("test", () => prepareJob("someTask", {}, options as never))).toThrow(z.ZodError);
  });

  it("refuses an empty identifier", () => {
    expect(() => runAsSystem("test", () => prepareJob("", {}, { jobKey: "k" }))).toThrow(z.ZodError);
  });

  it("leaves enqueueJob's unsafe_dedupe mode to its generic callers", async () => {
    const client = fakeClient();
    await runAsSystem("test", () =>
      enqueueJob(client as never, "someTask", {}, { jobKey: "k", jobKeyMode: "unsafe_dedupe" }),
    );
    expect(sentValues(client)[6]).toBe("unsafe_dedupe");
  });
});

describe("assertSearchTaskIdentifiersRegistered (R1 D1)", () => {
  it("passes when every search task identifier is visible", async () => {
    const client = fakeClient(SEARCH_TASK_IDENTIFIERS.map((identifier) => ({ identifier })));
    await expect(assertSearchTaskIdentifiersRegistered(client as never)).resolves.toBeUndefined();
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("graphile_worker._private_tasks"), [
      SEARCH_TASK_IDENTIFIERS,
    ]);
  });

  it("names the identifiers it did not see", async () => {
    const client = fakeClient([{ identifier: CORE_TASK_NAMES.ITEM_SEARCH_BACKFILL }]);
    const failure = await assertSearchTaskIdentifiersRegistered(client as never).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SearchTaskIdentifiersNotRegisteredError);
    if (!(failure instanceof SearchTaskIdentifiersNotRegisteredError)) throw new Error("Expected a refusal");
    expect(failure.missing).toEqual([
      CORE_TASK_NAMES.ITEM_SEARCH_PAGE_TEXT,
      CORE_TASK_NAMES.ITEM_SEARCH_REINDEX_DEPENDENTS,
    ]);
  });

  it("propagates the read's own failure", async () => {
    const failure = new Error('relation "graphile_worker._private_tasks" does not exist');
    const client = { query: vi.fn().mockRejectedValue(failure) };
    await expect(assertSearchTaskIdentifiersRegistered(client as never)).rejects.toBe(failure);
  });

  it("refuses a row that is not an identifier row", async () => {
    const client = fakeClient([{ identifier: 7 }]);
    await expect(assertSearchTaskIdentifiersRegistered(client as never)).rejects.toThrow(z.ZodError);
  });

  it("lists the three search tasks in code-unit order", () => {
    expect([...SEARCH_TASK_IDENTIFIERS]).toEqual(
      [
        CORE_TASK_NAMES.ITEM_SEARCH_PAGE_TEXT,
        CORE_TASK_NAMES.ITEM_SEARCH_REINDEX_DEPENDENTS,
        CORE_TASK_NAMES.ITEM_SEARCH_BACKFILL,
      ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });
});
