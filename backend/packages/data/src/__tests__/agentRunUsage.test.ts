import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTenantZeroUser,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import { createUser } from "../auth/usersStore.js";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import {
  failGatewayCall,
  recordTokenGatewayCall,
  reserveGatewayCall,
  settleAudioGatewayCall,
  settleTokenGatewayCall,
} from "../aiGateway/aiGatewayCallsStore.js";
import { getAgentRunUsage } from "../aiGateway/agentRunUsage.js";
import { withTransaction } from "../db/pool.js";
import { sendSempMessage } from "../sempThreads/sempThreadsStore.js";
import { claimSempMessage, startSempMessageTurn } from "../semp/sempMessagesStore.js";

const EMPTY_USAGE = { totalCostUsd: 0, estimated: false, perModel: [] };

/** A settled token call of the run. */
function recordCall(
  pool: Pool,
  agentRunId: string | null,
  model: string,
  usage: { inputTokens: number; outputTokens: number; costUsd: number },
) {
  return recordTokenGatewayCall(pool, { provider: "anthropic", model, agentRunId, ...usage });
}

describe("getAgentRunUsage (issue #1822)", () => {
  let pool: Pool;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await createTenantZeroUser(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function createRun(): Promise<string> {
    return (await createAgentRun(pool, { triggeredBy: "user", task: "usage" })).id;
  }

  it("aggregates two settled Sonnet calls into one entry with the summed tokens and cost", async () => {
    const runId = await createRun();
    await recordCall(pool, runId, "claude-sonnet-5", { inputTokens: 4000, outputTokens: 150, costUsd: 0.013 });
    await recordCall(pool, runId, "claude-sonnet-5", { inputTokens: 2180, outputTokens: 90, costUsd: 0.008 });

    expect(await getAgentRunUsage(pool, runId, "en")).toEqual({
      totalCostUsd: 0.021,
      estimated: false,
      perModel: [
        {
          provider: "anthropic",
          model: "claude-sonnet-5",
          displayName: "Claude Sonnet",
          callCount: 2,
          inputTokens: 6180,
          outputTokens: 240,
          audioSeconds: null,
          costUsd: 0.021,
        },
      ],
    });
  });

  it("leaves a failed call out of the call count and the cost", async () => {
    const runId = await createRun();
    await recordCall(pool, runId, "claude-sonnet-5", { inputTokens: 4000, outputTokens: 150, costUsd: 0.013 });
    const before = await getAgentRunUsage(pool, runId, "en");
    const failed = await reserveGatewayCall(pool, {
      provider: "anthropic",
      model: "claude-sonnet-5",
      estimatedCostUsd: 5,
      agentRunId: runId,
    });
    await failGatewayCall(pool, failed.id);
    const onlyFailedRunId = await createRun();
    const onlyFailed = await reserveGatewayCall(pool, {
      provider: "anthropic",
      model: "claude-sonnet-5",
      estimatedCostUsd: 5,
      agentRunId: onlyFailedRunId,
    });
    await failGatewayCall(pool, onlyFailed.id);

    const after = await getAgentRunUsage(pool, runId, "en");

    expect(before.perModel).toMatchObject([{ callCount: 1, costUsd: 0.013 }]);
    expect(after).toEqual(before);
    expect(await getAgentRunUsage(pool, onlyFailedRunId, "en")).toEqual(EMPTY_USAGE);
  });

  it("counts a reserved call at its estimate and reports the usage as estimated", async () => {
    const runId = await createRun();
    await recordCall(pool, runId, "claude-sonnet-5", { inputTokens: 100, outputTokens: 50, costUsd: 0.01 });
    await reserveGatewayCall(pool, {
      provider: "anthropic",
      model: "claude-sonnet-5",
      estimatedCostUsd: 0.5,
      agentRunId: runId,
    });
    const onlyReservedRunId = await createRun();
    await reserveGatewayCall(pool, {
      provider: "anthropic",
      model: "claude-haiku-4",
      estimatedCostUsd: 0.25,
      agentRunId: onlyReservedRunId,
    });

    expect(await getAgentRunUsage(pool, runId, "en")).toMatchObject({
      totalCostUsd: 0.51,
      estimated: true,
      perModel: [{ callCount: 2, inputTokens: 100, outputTokens: 50, costUsd: 0.51 }],
    });
    expect(await getAgentRunUsage(pool, onlyReservedRunId, "en")).toEqual({
      totalCostUsd: 0.25,
      estimated: true,
      perModel: [
        {
          provider: "anthropic",
          model: "claude-haiku-4",
          displayName: "Claude Haiku",
          callCount: 1,
          inputTokens: 0,
          outputTokens: 0,
          audioSeconds: null,
          costUsd: 0.25,
        },
      ],
    });
  });

  it("returns one entry per model, the most expensive first and equal costs by model", async () => {
    const runId = await createRun();
    await recordCall(pool, runId, "mystery-model", { inputTokens: 10, outputTokens: 1, costUsd: 0.1 });
    await recordCall(pool, runId, "claude-sonnet-5", { inputTokens: 300, outputTokens: 30, costUsd: 0.7 });
    await recordCall(pool, runId, "claude-haiku-4", { inputTokens: 20, outputTokens: 2, costUsd: 0.1 });

    const usage = await getAgentRunUsage(pool, runId, "en");

    expect(usage.perModel.map((entry) => [entry.model, entry.costUsd, entry.callCount])).toEqual([
      ["claude-sonnet-5", 0.7, 1],
      ["claude-haiku-4", 0.1, 1],
      ["mystery-model", 0.1, 1],
    ]);
    // Added as binary floating point, 0.7 + 0.1 + 0.1 is 0.8999999999999999; the total is the decimal sum.
    expect(usage.totalCostUsd).toBe(0.9);
    expect(usage.estimated).toBe(false);
  });

  it("names a new Sonnet version by its family and returns an unknown model id raw", async () => {
    const runId = await createRun();
    await recordCall(pool, runId, "claude-sonnet-9-20300101", { inputTokens: 1, outputTokens: 1, costUsd: 0.2 });
    await recordCall(pool, runId, "mystery-model", { inputTokens: 1, outputTokens: 1, costUsd: 0.1 });

    const usage = await getAgentRunUsage(pool, runId, "en");

    expect(usage.perModel.map((entry) => [entry.model, entry.displayName])).toEqual([
      ["claude-sonnet-9-20300101", "Claude Sonnet"],
      ["mystery-model", "mystery-model"],
    ]);
  });

  it("returns audio seconds for a model whose calls carry them, and its name in the given locale", async () => {
    const runId = await createRun();
    const audio = await reserveGatewayCall(pool, {
      provider: "deepinfra",
      model: "pyannote/speaker-diarization",
      estimatedCostUsd: 1,
      agentRunId: runId,
    });
    await settleAudioGatewayCall(pool, audio.id, { audioSeconds: 12.5, costUsd: 0.03 });

    const czech = await getAgentRunUsage(pool, runId, "cs");
    const english = await getAgentRunUsage(pool, runId, "en");

    expect(czech).toEqual({
      totalCostUsd: 0.03,
      estimated: false,
      perModel: [
        {
          provider: "deepinfra",
          model: "pyannote/speaker-diarization",
          displayName: "Diarizace",
          callCount: 1,
          inputTokens: 0,
          outputTokens: 0,
          audioSeconds: 12.5,
          costUsd: 0.03,
        },
      ],
    });
    expect(english.perModel.map((entry) => entry.displayName)).toEqual(["Diarization"]);
  });

  it("returns an empty usage for a run without calls, counting no other run's call and no call without a run", async () => {
    const runId = await createRun();
    const otherRunId = await createRun();
    await recordCall(pool, otherRunId, "claude-sonnet-5", { inputTokens: 100, outputTokens: 50, costUsd: 0.01 });
    await recordCall(pool, null, "claude-sonnet-5", { inputTokens: 100, outputTokens: 50, costUsd: 0.02 });

    expect(await getAgentRunUsage(pool, runId, "en")).toEqual(EMPTY_USAGE);
    expect(await getAgentRunUsage(pool, otherRunId, "en")).toMatchObject({
      totalCostUsd: 0.01,
      perModel: [{ callCount: 1 }],
    });
  });

  describe("of one Semp message (issue #1889)", () => {
    /** Two assistant messages of one thread, as two replies of one conversation run. */
    async function twoMessages(): Promise<{ first: string; second: string }> {
      return runInTenant(getTenantZeroId(), async () => {
        const sent = await withTransaction(pool, (client) =>
          sendSempMessage(client, { text: "one", context: [], hasContext: false }),
        );
        const next = await withTransaction(pool, (client) =>
          sendSempMessage(client, { threadId: sent.threadId, text: "two", context: [], hasContext: false }),
        );
        return { first: sent.assistantMessageId, second: next.assistantMessageId };
      });
    }

    async function attributedCall(runId: string, messageId: string | null, costUsd: number): Promise<void> {
      const reserved = await reserveGatewayCall(pool, {
        provider: "anthropic",
        model: "claude-sonnet-5",
        estimatedCostUsd: costUsd,
        agentRunId: runId,
        sempMessageId: messageId,
      });
      await settleTokenGatewayCall(pool, reserved.id, { inputTokens: 10, outputTokens: 1, costUsd });
    }

    it("aggregates only the calls attributed to that message, and every call of the run without one", async () => {
      const runId = await createRun();
      const { first, second } = await twoMessages();
      await attributedCall(runId, first, 0.01);
      await attributedCall(runId, second, 0.02);
      await attributedCall(runId, second, 0.04);
      await attributedCall(runId, null, 0.08);

      expect(await getAgentRunUsage(pool, runId, "en", first)).toMatchObject({
        totalCostUsd: 0.01,
        perModel: [{ callCount: 1, inputTokens: 10, costUsd: 0.01 }],
      });
      expect(await getAgentRunUsage(pool, runId, "en", second)).toMatchObject({
        totalCostUsd: 0.06,
        perModel: [{ callCount: 2, inputTokens: 20, costUsd: 0.06 }],
      });
      expect(await getAgentRunUsage(pool, runId, "en")).toMatchObject({
        totalCostUsd: 0.15,
        perModel: [{ callCount: 4 }],
      });
    });

    it("counts nothing for a message whose calls belong to another run, and for a message without calls", async () => {
      const runId = await createRun();
      const otherRunId = await createRun();
      const { first, second } = await twoMessages();
      await attributedCall(otherRunId, first, 0.01);

      expect(await getAgentRunUsage(pool, runId, "en", first)).toEqual(EMPTY_USAGE);
      expect(await getAgentRunUsage(pool, runId, "en", second)).toEqual(EMPTY_USAGE);
      expect(await getAgentRunUsage(pool, otherRunId, "en", first)).toMatchObject({ totalCostUsd: 0.01 });
    });

    describe("a call that carries only the message (issue #2020)", () => {
      /** Attributes a call to the message alone, as the speech-to-text rows of a spoken question are. */
      async function messageOnlyCall(messageId: string, costUsd: number): Promise<void> {
        const reserved = await reserveGatewayCall(pool, {
          provider: "fake-stt",
          model: "fake-stt-model",
          estimatedCostUsd: costUsd,
          sempMessageId: messageId,
        });
        await settleAudioGatewayCall(pool, reserved.id, { audioSeconds: 1, costUsd });
      }

      /** The turn of the message starts: the message names the run, as the Semp turn runner stores it. */
      async function startTurn(threadMessageId: string, runId: string): Promise<void> {
        await runInTenant(getTenantZeroId(), () =>
          withTransaction(pool, async (client) => {
            const thread = await client.query<{ thread_id: string }>(
              "SELECT thread_id FROM semp_messages WHERE id = $1",
              [threadMessageId],
            );
            const threadId = thread.rows[0]?.thread_id;
            if (!threadId) throw new Error("message has no thread");
            expect(await claimSempMessage(client, threadId, threadMessageId)).toBe(true);
            await startSempMessageTurn(client, threadMessageId, runId, "1");
          }),
        );
      }

      it("is counted for the reply when the message belongs to the run, with the calls that name the run", async () => {
        const runId = await createRun();
        const { first } = await twoMessages();
        await startTurn(first, runId);
        await attributedCall(runId, first, 0.01);
        await messageOnlyCall(first, 0.03);

        expect(await getAgentRunUsage(pool, runId, "en", first)).toMatchObject({
          totalCostUsd: 0.04,
          perModel: [
            { provider: "fake-stt", callCount: 1, audioSeconds: 1, costUsd: 0.03 },
            { provider: "anthropic", callCount: 1, costUsd: 0.01 },
          ],
        });
      });

      it("is not counted for another run, for a message that belongs to no run, or for a call that names another run", async () => {
        const runId = await createRun();
        const otherRunId = await createRun();
        const { first, second } = await twoMessages();
        await startTurn(first, runId);
        await messageOnlyCall(first, 0.03);
        await messageOnlyCall(second, 0.05);
        // A call of another run attributed to the same message is not made the run's by the message.
        await attributedCall(otherRunId, first, 0.5);

        expect(await getAgentRunUsage(pool, otherRunId, "en", first)).toMatchObject({
          totalCostUsd: 0.5,
          perModel: [{ provider: "anthropic", callCount: 1 }],
        });
        expect(await getAgentRunUsage(pool, runId, "en", second)).toEqual(EMPTY_USAGE);
        expect(await getAgentRunUsage(pool, runId, "en", first)).toMatchObject({
          totalCostUsd: 0.03,
          perModel: [{ provider: "fake-stt", callCount: 1 }],
        });
      });

      it("is not part of the usage of the whole run, which counts only the calls that carry the run's id", async () => {
        const runId = await createRun();
        const { first } = await twoMessages();
        await startTurn(first, runId);
        await attributedCall(runId, first, 0.01);
        await messageOnlyCall(first, 0.03);

        expect(await getAgentRunUsage(pool, runId, "en")).toMatchObject({
          totalCostUsd: 0.01,
          perModel: [{ provider: "anthropic", callCount: 1 }],
        });
      });
    });
  });
});

describe("getAgentRunUsage in a tenant (issue #1822)", () => {
  let adminPool: Pool;
  let runtimePool: Pool;

  beforeAll(async () => {
    adminPool = getTestPool();
    runtimePool = await runInTenant(getTenantZeroId(), () => createRuntimeRolePool(adminPool, "semprec_data"));
  });

  beforeEach(async () => {
    await runInTenant(getTenantZeroId(), () => resetDatabase(adminPool));
  });

  afterAll(async () => {
    await Promise.all([runtimePool?.end(), adminPool?.end()]);
  });

  it("returns a run's usage in its own tenant and an empty usage in another tenant", async () => {
    const tenantA = getTenantZeroId();
    const tenantB = await runInTenant(tenantA, () => createTestTenant(adminPool));
    const runWithCall = (tenantId: string, costUsd: number) =>
      runInTenant(tenantId, async () => {
        await createUser(adminPool, { email: `${randomUUID()}@example.test`, passwordHash: "x", tenantId });
        const run = await createAgentRun(runtimePool, { triggeredBy: "user", task: "usage" });
        await recordCall(runtimePool, run.id, "claude-sonnet-5", { inputTokens: 100, outputTokens: 50, costUsd });
        return run.id;
      });
    const runA = await runWithCall(tenantA, 0.01);
    const runB = await runWithCall(tenantB, 0.07);

    const ownA = await runInTenant(tenantA, () => getAgentRunUsage(runtimePool, runA, "en"));
    const foreignA = await runInTenant(tenantB, () => getAgentRunUsage(runtimePool, runA, "en"));
    const ownB = await runInTenant(tenantB, () => getAgentRunUsage(runtimePool, runB, "en"));

    expect(ownA).toMatchObject({ totalCostUsd: 0.01, perModel: [{ callCount: 1, costUsd: 0.01 }] });
    expect(foreignA).toEqual(EMPTY_USAGE);
    expect(ownB).toMatchObject({ totalCostUsd: 0.07, perModel: [{ callCount: 1, costUsd: 0.07 }] });
  });
});
