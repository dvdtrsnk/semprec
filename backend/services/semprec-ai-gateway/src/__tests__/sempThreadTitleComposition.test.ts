import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createModels } from "@earendil-works/pi-ai";
import { createHttpAiGatewayClient } from "@semprec/ai-gateway-client";
import {
  claimSempMessage,
  createAgentRun,
  createActionRegistry,
  createApiCoreTaskList,
  createChokePoint,
  createHeartbeat,
  createUser,
  enqueueSempThreadTitleIfFirst,
  finishSempMessageTurn,
  getDatabaseByModuleId,
  handleSempThreadTitle,
  insertAgentRunEvent,
  seedSystem,
  sendSempMessage,
  startSempMessageTurn,
  withTransaction,
} from "@semprec/data";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  setTenantAiBudget,
} from "@semprec/data/testSupport";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { CORE_TASK_NAMES, runOnce, type TaskList } from "@semprec/queue";
import { createDispatcher } from "../app.js";
import { GENEROUS_GLOBAL_CAPS } from "./globalCaps.js";
import {
  ProviderCallError,
  type StructuredCompletionProvider,
  type StructuredCompletionRequest,
} from "../structuredProviders/types.js";

let admin: Pool;
let pool: Pool;
let server: Server;
let tenant: string;
let port: number;
const calls: StructuredCompletionRequest[] = [];
let providerFailure = false;
let providerGate: (() => Promise<void>) | undefined;
let providerTitle = '  "Useful title"  ';
const providerSecret = "title-provider-secret-sentinel";
const token = "title-test-token";
const provider: StructuredCompletionProvider = {
  id: "title-provider",
  supportsJsonSchemaStructuredOutput: true,
  async complete(request) {
    calls.push(request);
    await providerGate?.();
    if (providerFailure) throw new ProviderCallError(`token=${providerSecret}`);
    return { content: { title: providerTitle }, inputTokens: 31, outputTokens: 8 };
  },
};

async function completedChat(
  userText = "My first question",
  assistantText = "First answer",
  enqueueTitle = false,
  tenantId = tenant,
): Promise<string> {
  return runInTenant(tenantId, () =>
    withTransaction(pool, async (client) => {
      const turn = await sendSempMessage(client, { text: userText, context: [], hasContext: false });
      expect(await claimSempMessage(client, turn.threadId, turn.assistantMessageId)).toBe(true);
      const run = await createAgentRun(client, {
        triggeredBy: "user",
        unit: "session",
        task: userText,
        threadId: turn.threadId,
      });
      const event = await insertAgentRunEvent(client, run.id, "message", { kind: "message", text: assistantText });
      await startSempMessageTurn(client, turn.assistantMessageId, run.id, event.id);
      expect(
        await finishSempMessageTurn(client, turn.assistantMessageId, {
          status: "done",
          text: assistantText,
          lastEventId: event.id,
        }),
      ).toBe(true);
      if (enqueueTitle) await enqueueSempThreadTitleIfFirst(client, turn.threadId, turn.assistantMessageId);
      return turn.threadId;
    }),
  );
}

function titleTaskList(): TaskList {
  const gateway = createHttpAiGatewayClient({ port, token });
  const registered = createApiCoreTaskList(
    pool,
    createActionRegistry(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    gateway,
  );
  const title = registered[CORE_TASK_NAMES.SEMP_THREAD_TITLE];
  if (!title) throw new Error("Missing registered title task");
  return { [CORE_TASK_NAMES.SEMP_THREAD_TITLE]: title };
}

function titleJob(threadId: string) {
  return runInTenant(tenant, () =>
    pool.query<{ key: string; task_identifier: string; max_attempts: number }>(
      "SELECT key, task_identifier, max_attempts FROM graphile_worker.jobs WHERE key = $1",
      [`sempThreadTitle:${threadId}`],
    ),
  );
}

function readTitle(threadId: string) {
  return runInTenant(tenant, () =>
    pool.query<{ title: string | null }>("SELECT title FROM semp_threads WHERE id = $1", [threadId]),
  );
}

describe("Semp title through the real gateway", () => {
  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    tenant = await createTestTenant(admin);
    await setTenantAiBudget(admin, tenant);
    await createUser(admin, {
      tenantId: tenant,
      email: `${randomUUID()}@example.test`,
      passwordHash: "unused",
      locale: "en",
    });
    await runInTenant(tenant, () => seedSystem(pool));
    server = createServer(
      createDispatcher(
        pool,
        {
          internalToken: token,
          provider,
          model: "test-model",
          pricePerMillionInputTokens: 3,
          pricePerMillionOutputTokens: 15,
          globalCaps: GENEROUS_GLOBAL_CAPS,
        },
        {
          internalToken: token,
          diarizationProvider: { id: "unused", model: "unused", diarize: async () => [] },
          transcriptionProvider: {
            id: "unused",
            model: "unused",
            transcribe: async () => ({ text: "", language: null, segments: [] }),
          },
          pyannotePricePerAudioHour: 1,
          deepInfraPricePerAudioHour: 1,
          globalCaps: GENEROUS_GLOBAL_CAPS,
        },
        {
          internalToken: token,
          models: createModels(),
          apiKey: "unused",
          globalCaps: GENEROUS_GLOBAL_CAPS,
          streamFn: () => {
            throw new Error("unexpected pi request");
          },
        },
      ),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    port = address.port;
  });

  afterAll(async () => {
    const failures: unknown[] = [];
    if (server)
      await new Promise<void>((resolve) =>
        server.close((error) => {
          if (error) failures.push(error);
          resolve();
        }),
      );
    try {
      await pool?.end();
    } catch (error) {
      failures.push(error);
    }
    try {
      await admin?.end();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, "Title composition cleanup failed", { cause: failures[0] });
  });

  it("sends the first exchange to the real HTTP gateway and records its operation", async () => {
    const threadId = await completedChat();
    const gateway = createHttpAiGatewayClient({ port, token });
    await runInTenant(tenant, () => handleSempThreadTitle(pool, threadId, gateway));
    const result = await runInTenant(tenant, async () => ({
      title: (await pool.query<{ title: string }>("SELECT title FROM semp_threads WHERE id = $1", [threadId])).rows,
      accounting: (
        await pool.query<{
          operation: string;
          input_tokens: number;
          output_tokens: number;
          project_item_id: string | null;
        }>(
          "SELECT operation, input_tokens, output_tokens, project_item_id FROM ai_gateway_calls WHERE operation = 'semp_thread_title'",
        )
      ).rows,
    }));
    expect(result.title).toEqual([{ title: "Useful title" }]);
    expect(result.accounting).toEqual([
      { operation: "semp_thread_title", input_tokens: 31, output_tokens: 8, project_item_id: null },
    ]);
    expect(Array.from(result.title[0]?.title ?? "").length).toBeLessThanOrEqual(60);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.system).toContain("locale: en");
    expect(calls[0]?.system).toContain("user's language");
    expect(calls[0]?.messages).toEqual([
      { role: "user", content: "My first question" },
      { role: "assistant", content: "First answer" },
    ]);
    await runInTenant(tenant, () => handleSempThreadTitle(pool, threadId, gateway));
    expect(calls).toHaveLength(1);
    expect(
      (
        await runInTenant(tenant, () =>
          pool.query<{ title: string }>("SELECT title FROM semp_threads WHERE id = $1", [threadId]),
        )
      ).rows,
    ).toEqual([{ title: "Useful title" }]);
  });

  it("keeps user titles, budget refusals and provider failures unchanged", async () => {
    const gateway = createHttpAiGatewayClient({ port, token });
    const manual = await completedChat();
    // User renaming has no production writer in this batch; this is an existing valid stored state.
    await runInTenant(tenant, () =>
      pool.query("UPDATE semp_threads SET title = 'Manual', title_source = 'user' WHERE id = $1", [manual]),
    );
    const before = calls.length;
    await runInTenant(tenant, () => handleSempThreadTitle(pool, manual, gateway));
    expect(calls).toHaveLength(before);
    const budget = await completedChat();
    await setTenantAiBudget(admin, tenant, { dailyCapUsd: 0 });
    try {
      await runInTenant(tenant, () => handleSempThreadTitle(pool, budget, gateway));
      expect(calls).toHaveLength(before);
    } finally {
      await setTenantAiBudget(admin, tenant);
    }
    const failed = await completedChat();
    providerFailure = true;
    try {
      await runInTenant(tenant, () => handleSempThreadTitle(pool, failed, gateway));
    } finally {
      providerFailure = false;
    }
    expect(calls).toHaveLength(before + 1);
    const titles = await runInTenant(tenant, () =>
      pool.query<{ id: string; title: string | null }>(
        "SELECT id, title FROM semp_threads WHERE id = ANY($1::uuid[]) ORDER BY id",
        [[manual, budget, failed]],
      ),
    );
    expect(new Map(titles.rows.map((row) => [row.id, row.title]))).toEqual(
      new Map([
        [manual, "Manual"],
        [budget, null],
        [failed, null],
      ]),
    );
  });

  it("settles an admitted title job on budget refusal without retrying", async () => {
    const threadId = await completedChat("Budget question", "Budget answer", true);
    const tasks = titleTaskList();
    const before = calls.length;
    expect((await titleJob(threadId)).rows).toEqual([
      { key: `sempThreadTitle:${threadId}`, task_identifier: "sempThreadTitle", max_attempts: 1 },
    ]);
    await setTenantAiBudget(admin, tenant, { dailyCapUsd: 0 });
    let failure: { error: unknown } | undefined;
    try {
      await runOnce({ pgPool: pool, taskList: tasks });
      expect((await titleJob(threadId)).rows).toEqual([]);
      expect((await readTitle(threadId)).rows).toEqual([{ title: null }]);
      expect(calls).toHaveLength(before);
      await runOnce({ pgPool: pool, taskList: tasks });
      expect((await titleJob(threadId)).rows).toEqual([]);
      expect(calls).toHaveLength(before);
    } catch (error) {
      failure = { error };
    }
    try {
      await setTenantAiBudget(admin, tenant);
    } catch (error) {
      if (failure) {
        throw new AggregateError([failure.error, error], "Title budget fixture cleanup failed", {
          // Preserve the assertion failure and retain the budget restoration failure.
          // eslint-disable-next-line preserve-caught-error
          cause: failure.error,
        });
      }
      throw error;
    }
    if (failure) throw failure.error;
  });

  it("settles an admitted title job on provider failure without retrying", async () => {
    const threadId = await completedChat("title-user-text-sentinel", "title-assistant-text-sentinel", true);
    const tasks = titleTaskList();
    const before = calls.length;
    expect((await titleJob(threadId)).rows).toEqual([
      { key: `sempThreadTitle:${threadId}`, task_identifier: "sempThreadTitle", max_attempts: 1 },
    ]);
    process.stdout.write(`${JSON.stringify({ type: "titlePrivacyFixture", tenantId: tenant, threadId })}\n`);
    providerFailure = true;
    try {
      await runOnce({ pgPool: pool, taskList: tasks });
      expect((await titleJob(threadId)).rows).toEqual([]);
      expect((await readTitle(threadId)).rows).toEqual([{ title: null }]);
      expect(calls).toHaveLength(before + 1);
      await runOnce({ pgPool: pool, taskList: tasks });
      expect((await titleJob(threadId)).rows).toEqual([]);
      expect((await readTitle(threadId)).rows).toEqual([{ title: null }]);
      expect(calls).toHaveLength(before + 1);
      const failed = await runInTenant(tenant, () =>
        pool.query<{ status: string; project_item_id: string | null }>(
          "SELECT status, project_item_id FROM ai_gateway_calls WHERE operation = 'semp_thread_title' ORDER BY at DESC LIMIT 1",
        ),
      );
      expect(failed.rows).toEqual([{ status: "failed", project_item_id: null }]);
    } finally {
      providerFailure = false;
    }
  });

  it("bounds the first exchange and discards an empty normalized title", async () => {
    const gateway = createHttpAiGatewayClient({ port, token });
    const threadId = await completedChat("u".repeat(1001), "a".repeat(1001));
    const before = calls.length;
    try {
      providerTitle = '  "first\nsecond"  ';
      await runInTenant(tenant, () => handleSempThreadTitle(pool, threadId, gateway));
      expect(calls).toHaveLength(before + 1);
      expect(calls[before]?.messages).toEqual([
        { role: "user", content: "u".repeat(1000) },
        { role: "assistant", content: "a".repeat(1000) },
      ]);
      const title = await runInTenant(tenant, () =>
        pool.query<{ title: string | null }>("SELECT title FROM semp_threads WHERE id = $1", [threadId]),
      );
      expect(title.rows).toEqual([{ title: "first second" }]);
      const empty = await completedChat();
      providerTitle = '""';
      await runInTenant(tenant, () => handleSempThreadTitle(pool, empty, gateway));
      const discarded = await runInTenant(tenant, () =>
        pool.query<{ title: string | null }>("SELECT title FROM semp_threads WHERE id = $1", [empty]),
      );
      expect(discarded.rows).toEqual([{ title: null }]);
    } finally {
      providerTitle = '  "Useful title"  ';
    }
  });

  it("uses the owning tenant's stored locale and refuses foreign or unknown threads", async () => {
    const localizedTenant = await createTestTenant(admin);
    await setTenantAiBudget(admin, localizedTenant);
    await createUser(admin, {
      tenantId: localizedTenant,
      email: `${randomUUID()}@example.test`,
      passwordHash: "unused",
      locale: "cs",
    });
    await runInTenant(localizedTenant, () => seedSystem(pool));
    const threadId = await completedChat("Czech locale question", "Czech locale answer", false, localizedTenant);
    const gateway = createHttpAiGatewayClient({ port, token });
    const before = calls.length;
    await runInTenant(tenant, () => handleSempThreadTitle(pool, threadId, gateway));
    await runInTenant(tenant, () => handleSempThreadTitle(pool, randomUUID(), gateway));
    expect(calls).toHaveLength(before);
    expect(
      (await runInTenant(tenant, () => pool.query("SELECT id FROM semp_threads WHERE id = $1", [threadId]))).rows,
    ).toEqual([]);
    await runInTenant(localizedTenant, () => handleSempThreadTitle(pool, threadId, gateway));
    expect(calls).toHaveLength(before + 1);
    expect(calls[before]?.system).toContain("locale: cs");
    const title = await runInTenant(localizedTenant, () =>
      pool.query<{ title: string | null }>("SELECT title FROM semp_threads WHERE id = $1", [threadId]),
    );
    expect(title.rows).toEqual([{ title: "Useful title" }]);
  });

  it("does not hold the thread lock while the real gateway is in flight", async () => {
    const threadId = await completedChat();
    const gateway = createHttpAiGatewayClient({ port, token });
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    providerGate = async () => {
      entered();
      await gate;
    };
    const request = runInTenant(tenant, () => handleSempThreadTitle(pool, threadId, gateway));
    let failure: { error: unknown } | undefined;
    try {
      await started;
      expect(pool.totalCount - pool.idleCount).toBe(0);
      await runInTenant(tenant, () =>
        withTransaction(pool, async (client) => {
          const locked = await client.query("SELECT id FROM semp_threads WHERE id = $1 FOR UPDATE NOWAIT", [threadId]);
          expect(locked.rowCount).toBe(1);
          // Renaming has no production writer in this batch; model an existing valid user-set title.
          const renamed = await client.query(
            "UPDATE semp_threads SET title = 'User title', title_source = 'user' WHERE id = $1",
            [threadId],
          );
          expect(renamed.rowCount).toBe(1);
        }),
      );
    } catch (error) {
      failure = { error };
    }
    release();
    providerGate = undefined;
    try {
      await request;
    } catch (error) {
      if (failure) {
        // Keep the assertion failure primary while retaining the in-flight request failure.
        // eslint-disable-next-line preserve-caught-error
        throw new AggregateError([failure.error, error], "Title request cleanup failed", { cause: failure.error });
      }
      throw error;
    }
    if (failure) throw failure.error;
    const title = await runInTenant(tenant, () =>
      pool.query<{ title: string; title_source: string }>(
        "SELECT title, title_source FROM semp_threads WHERE id = $1",
        [threadId],
      ),
    );
    expect(title.rows).toEqual([{ title: "User title", title_source: "user" }]);
  });

  it("does not call the gateway for item, tick, foreign or missing threads", async () => {
    const nonChat = await runInTenant(tenant, async () => {
      const inbox = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "inbox"));
      if (!inbox?.ownerProjectItemId) throw new Error("Missing Semprec project");
      const projectId = inbox.ownerProjectItemId;
      const source = await createChokePoint(pool).createItem({
        databaseId: inbox.id,
        properties: { date: "2026-01-01", time: "12:00", text: "source" },
      });
      return withTransaction(pool, async (client) => {
        const item = await sendSempMessage(client, {
          subject: { inboxItemId: source.id },
          text: "item",
          context: [],
          hasContext: false,
        });
        const heartbeat = await createHeartbeat(client, {
          projectItemId: projectId,
          name: "Tick",
          rule: { kind: "interval", minutes: 10 },
          actionId: "core.agentRun",
        });
        // This valid tick row stands in for the private data tick-store producer.
        const tick = await client.query<{ id: string }>(
          "INSERT INTO semp_threads (kind, heartbeat_id) VALUES ('tick', $1) RETURNING id",
          [heartbeat.id],
        );
        if (!tick.rows[0]) throw new Error("Missing tick thread");
        return [item.threadId, tick.rows[0].id];
      });
    });
    const other = await createTestTenant(admin);
    const foreign = await runInTenant(other, () =>
      withTransaction(pool, (client) => sendSempMessage(client, { text: "foreign", context: [], hasContext: false })),
    );
    const before = calls.length;
    const gateway = createHttpAiGatewayClient({ port, token });
    for (const threadId of [...nonChat, foreign.threadId, randomUUID()]) {
      await runInTenant(tenant, () => handleSempThreadTitle(pool, threadId, gateway));
    }
    expect(calls).toHaveLength(before);
    const titles = await runInTenant(tenant, () =>
      pool.query<{ title: string | null }>("SELECT title FROM semp_threads WHERE id = ANY($1::uuid[])", [nonChat]),
    );
    expect(titles.rows).toEqual([{ title: null }, { title: null }]);
    const foreignTitle = await runInTenant(other, () =>
      pool.query<{ title: string | null }>("SELECT title FROM semp_threads WHERE id = $1", [foreign.threadId]),
    );
    expect(foreignTitle.rows).toEqual([{ title: null }]);
  });
});
