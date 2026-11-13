import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";
import { ForbiddenError } from "../errors.js";
import {
  attributeGatewayCallsToSempMessage,
  failGatewayCall,
  reserveGatewayCall,
  settleAudioGatewayCall,
} from "../aiGateway/aiGatewayCallsStore.js";
import { createSempChatThread, insertSempUserTurn } from "../sempThreads/sempThreadsStore.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let adminPool: Pool;
/** The runtime-role pool applies the ambient tenant scope as `app.tenant_id` and enforces RLS. */
let pool: Pool;
let tenantA: string;
let tenantB: string;

const RESERVATION = { provider: "fake-stt", model: "fake-stt-model", estimatedCostUsd: 0.5 };

interface CallState {
  id: string;
  semp_message_id: string | null;
  status: string;
}

/** The speech-to-text chunk rows of a stream are reserved one by one, which is also how a test makes them. */
function reserveChunk(tenantId: string): Promise<string> {
  return runInTenant(tenantId, async () => (await reserveGatewayCall(pool, RESERVATION)).id);
}

function createMessage(tenantId: string): Promise<string> {
  return runInTenant(tenantId, () =>
    withTransaction(pool, async (client) => {
      const threadId = await createSempChatThread(client);
      return (await insertSempUserTurn(client, threadId, "Question", [])).assistantMessageId;
    }),
  );
}

/** Reads through the superuser pool, which sees every tenant's rows, so a row that must not change is checked. */
async function stateOf(ids: string[]): Promise<CallState[]> {
  const { rows } = await adminPool.query<CallState>(
    "SELECT id::text, semp_message_id, status FROM ai_gateway_calls WHERE id = ANY($1::bigint[]) ORDER BY id",
    [ids],
  );
  return rows;
}

async function expectRefused(promise: Promise<unknown>): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(ForbiddenError);
  if (!(error instanceof ForbiddenError)) throw new Error("expected a ForbiddenError");
  expect(error.status).toBe(403);
  expect(error.code).toBe("attribution_refused");
  expect(error.details).toBeUndefined();
}

describe("attributeGatewayCallsToSempMessage", () => {
  beforeEach(async () => {
    adminPool ??= getTestPool();
    await resetDatabase(adminPool);
    tenantA = await createTestTenant(adminPool);
    tenantB = await createTestTenant(adminPool);
    pool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  afterEach(async () => {
    await pool.end();
  });

  afterAll(async () => {
    await adminPool?.end();
  });

  it("sets the message on every given row whatever its status and on no other row of the tenant", async () => {
    const reserved = await reserveChunk(tenantA);
    const settled = await reserveChunk(tenantA);
    const failed = await reserveChunk(tenantA);
    const untouched = await reserveChunk(tenantA);
    await runInTenant(tenantA, async () => {
      await settleAudioGatewayCall(pool, settled, { audioSeconds: 1, costUsd: 0.01 });
      await failGatewayCall(pool, failed);
    });
    const messageId = await createMessage(tenantA);

    await runInTenant(tenantA, () => attributeGatewayCallsToSempMessage(pool, [reserved, settled, failed], messageId));

    expect(await stateOf([reserved, settled, failed, untouched])).toEqual([
      { id: reserved, semp_message_id: messageId, status: "reserved" },
      { id: settled, semp_message_id: messageId, status: "settled" },
      { id: failed, semp_message_id: messageId, status: "failed" },
      { id: untouched, semp_message_id: null, status: "reserved" },
    ]);
  });

  it("sends no statement for no rows, so even an unknown message is not looked up", async () => {
    await expect(
      runInTenant(tenantA, () => attributeGatewayCallsToSempMessage(pool, [], randomUUID())),
    ).resolves.toBeUndefined();
  });

  it("refuses a message that does not exist and changes no row", async () => {
    const id = await reserveChunk(tenantA);

    await expectRefused(runInTenant(tenantA, () => attributeGatewayCallsToSempMessage(pool, [id], randomUUID())));

    expect(await stateOf([id])).toEqual([{ id, semp_message_id: null, status: "reserved" }]);
  });

  it("refuses another tenant's message exactly like an unknown one and changes no row", async () => {
    const id = await reserveChunk(tenantA);
    const foreignMessage = await createMessage(tenantB);

    await expectRefused(runInTenant(tenantA, () => attributeGatewayCallsToSempMessage(pool, [id], foreignMessage)));

    expect(await stateOf([id])).toEqual([{ id, semp_message_id: null, status: "reserved" }]);
  });

  it("refuses a row of another tenant and changes neither it nor the tenant's own rows given with it", async () => {
    const own = await reserveChunk(tenantA);
    const foreignRow = await reserveChunk(tenantB);
    const messageId = await createMessage(tenantA);

    await expectRefused(
      runInTenant(tenantA, () => attributeGatewayCallsToSempMessage(pool, [own, foreignRow], messageId)),
    );

    expect(await stateOf([own, foreignRow])).toEqual([
      { id: own, semp_message_id: null, status: "reserved" },
      { id: foreignRow, semp_message_id: null, status: "reserved" },
    ]);
  });

  it("refuses a row id that does not exist and changes nothing", async () => {
    const own = await reserveChunk(tenantA);
    const messageId = await createMessage(tenantA);

    await expectRefused(
      runInTenant(tenantA, () => attributeGatewayCallsToSempMessage(pool, [own, "999999999"], messageId)),
    );

    expect(await stateOf([own])).toEqual([{ id: own, semp_message_id: null, status: "reserved" }]);
  });
});
