import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createTestProjectItem, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { withTransaction } from "../db/pool.js";
import { createAgentRun, getAgentRun } from "../agentRuns/agentRunsStore.js";
import { listAgentRunEvents } from "../agentRuns/agentRunEventsStore.js";
import { createUser } from "../auth/usersStore.js";
import { hashPassword } from "../auth/passwordHash.js";
import { mintMcpRunCredential, resolveMcpRunCredential } from "../mcp/mcpRunCredentialAction.js";
import { handleMcpRunCredentialExpirySweepTask } from "../mcp/mcpRunCredentialExpiry.js";

let pool: Pool;

describe("handleMcpRunCredentialExpirySweepTask (issue #643)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function mintCredential() {
    const passwordHash = await hashPassword("s3cret-password");
    const user = await createUser(pool, { email: `owner-${randomUUID()}@example.test`, passwordHash, locale: "en" });
    const projectItemId = await createTestProjectItem(pool);
    return withTransaction(pool, (client) =>
      mintMcpRunCredential(client, { projectItemId, capabilities: ["core.item.read"], userId: user.id }),
    );
  }

  async function expireCredential(agentRunId: string): Promise<void> {
    await pool.query(
      `UPDATE agent_run_mcp_credentials SET expires_at = now() - interval '1 minute' WHERE agent_run_id = $1`,
      [agentRunId],
    );
  }

  async function agentRunErrorNotificationCount(agentRunId: string): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM notifications WHERE kind = 'agent_run_error' AND source_id = $1`,
      [agentRunId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  it("finishes an expired credential's running run as done, appends a run_status event, and writes no error notification", async () => {
    const minted = await mintCredential();
    await expireCredential(minted.run.id);
    const { rows: credentialRows } = await pool.query<{ expires_at: Date }>(
      `SELECT expires_at FROM agent_run_mcp_credentials WHERE agent_run_id = $1`,
      [minted.run.id],
    );
    const expiresAtIso = credentialRows[0]!.expires_at.toISOString();

    const result = await handleMcpRunCredentialExpirySweepTask(pool);

    expect(result).toEqual({ finishedRunIds: [minted.run.id] });
    const run = await getAgentRun(pool, minted.run.id);
    expect(run).toMatchObject({ status: "done", result: `MCP run-credential expired at ${expiresAtIso}` });
    expect(run!.finishedAt).not.toBeNull();

    const events = await listAgentRunEvents(pool, minted.run.id);
    expect(events.map((event) => ({ kind: event.kind, payload: event.payload }))).toEqual([
      { kind: "run_status", payload: { kind: "run_status", status: "done" } },
    ]);

    expect(await resolveMcpRunCredential(pool, minted.token)).toBeNull();
    expect(await agentRunErrorNotificationCount(minted.run.id)).toBe(0);
  });

  it("changes nothing when it runs again after the run is already finished", async () => {
    const minted = await mintCredential();
    await expireCredential(minted.run.id);
    await handleMcpRunCredentialExpirySweepTask(pool);
    const afterFirst = await getAgentRun(pool, minted.run.id);

    const second = await handleMcpRunCredentialExpirySweepTask(pool);

    expect(second).toEqual({ finishedRunIds: [] });
    expect(await getAgentRun(pool, minted.run.id)).toEqual(afterFirst);
    expect(await listAgentRunEvents(pool, minted.run.id)).toHaveLength(1);
  });

  it("leaves a run whose credential is still valid running", async () => {
    const minted = await mintCredential();

    const result = await handleMcpRunCredentialExpirySweepTask(pool);

    expect(result).toEqual({ finishedRunIds: [] });
    const run = await getAgentRun(pool, minted.run.id);
    expect(run).toMatchObject({ status: "running", result: null, finishedAt: null });
    expect(await listAgentRunEvents(pool, minted.run.id)).toHaveLength(0);
    expect(await resolveMcpRunCredential(pool, minted.token)).not.toBeNull();
  });

  it("never touches a running run that is not triggered by mcp", async () => {
    const minted = await mintCredential();
    const heartbeatRun = await createAgentRun(pool, { triggeredBy: "heartbeat", task: "heartbeat task" });
    // Point the expired credential at the heartbeat run, so only the triggered_by filter excludes it.
    await pool.query(
      `UPDATE agent_run_mcp_credentials SET agent_run_id = $2, expires_at = now() - interval '1 minute'
       WHERE agent_run_id = $1`,
      [minted.run.id, heartbeatRun.id],
    );

    const result = await handleMcpRunCredentialExpirySweepTask(pool);

    expect(result).toEqual({ finishedRunIds: [] });
    const run = await getAgentRun(pool, heartbeatRun.id);
    expect(run).toMatchObject({ status: "running", result: null, finishedAt: null });
    expect(await listAgentRunEvents(pool, heartbeatRun.id)).toHaveLength(0);
  });
});
