import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createModels } from "@earendil-works/pi-ai";
import { createHttpAiGatewayClient } from "@semprec/ai-gateway-client";
import {
  claimSempMessage,
  createAgentRun,
  createUser,
  finishSempMessageTurn,
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
const token = "title-test-token";
const provider: StructuredCompletionProvider = {
  id: "title-provider",
  supportsJsonSchemaStructuredOutput: true,
  async complete(request) {
    calls.push(request);
    await providerGate?.();
    if (providerFailure) throw new ProviderCallError("provider unavailable");
    return { content: { title: '  "A useful title"  ' }, inputTokens: 31, outputTokens: 8 };
  },
};

async function completedChat(): Promise<string> {
  return runInTenant(tenant, () =>
    withTransaction(pool, async (client) => {
      const turn = await sendSempMessage(client, { text: "My first question", context: [], hasContext: false });
      expect(await claimSempMessage(client, turn.threadId, turn.assistantMessageId)).toBe(true);
      const run = await createAgentRun(client, {
        triggeredBy: "user",
        unit: "session",
        task: "My first question",
        threadId: turn.threadId,
      });
      const event = await insertAgentRunEvent(client, run.id, "message", { kind: "message", text: "First answer" });
      await startSempMessageTurn(client, turn.assistantMessageId, run.id, event.id);
      expect(
        await finishSempMessageTurn(client, turn.assistantMessageId, {
          status: "done",
          text: "First answer",
          lastEventId: event.id,
        }),
      ).toBe(true);
      return turn.threadId;
    }),
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
    await createUser(admin, { tenantId: tenant, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
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
        await pool.query<{ operation: string; input_tokens: number; output_tokens: number }>(
          "SELECT operation, input_tokens, output_tokens FROM ai_gateway_calls WHERE operation = 'semp_thread_title'",
        )
      ).rows,
    }));
    expect(result.title).toEqual([{ title: "A useful title" }]);
    expect(result.accounting).toEqual([{ operation: "semp_thread_title", input_tokens: 31, output_tokens: 8 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.messages).toEqual([
      { role: "user", content: "My first question" },
      { role: "assistant", content: "First answer" },
    ]);
    await runInTenant(tenant, () => handleSempThreadTitle(pool, threadId, gateway));
    expect(calls).toHaveLength(1);
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
    try {
      await started;
      expect(pool.totalCount - pool.idleCount).toBe(0);
      await runInTenant(tenant, () =>
        withTransaction(pool, async (client) => {
          const locked = await client.query("SELECT id FROM semp_threads WHERE id = $1 FOR UPDATE NOWAIT", [threadId]);
          expect(locked.rowCount).toBe(1);
        }),
      );
    } finally {
      release();
      providerGate = undefined;
      await request;
    }
  });
});
