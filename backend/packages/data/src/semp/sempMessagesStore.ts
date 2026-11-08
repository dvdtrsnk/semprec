import type { Pool, PoolClient } from "pg";
import { requireAffectedRows, requireManagedTransaction } from "../db/pool.js";
import { assertKnownValue } from "../dbRowValidation.js";
import { allocateSempMessageTimestamp } from "./sempMessageOrder.js";
import { currentTenantScope } from "@semprec/shared";
import { publishSempThreadInvalidation } from "../realtimeHook.js";

// A fixed SQL fragment; no caller input is interpolated.
const MESSAGE_TOKEN = `jsonb_build_object('id', id, 'role', role, 'text', text, 'status', status,
  'context', context, 'systemKey', system_key, 'systemParams', system_params,
  'replyTo', reply_to_message_id, 'run', agent_run_id, 'from', event_from_id, 'to', event_to_id,
  'errorCode', error_code, 'createdAt', created_at, 'updatedAt', updated_at)::text`;

/** Reads the queued assistant for one thread turn under the current tenant. */
export async function getSempVoiceDelivery(client: Pool | PoolClient, threadId: string, assistantMessageId: string) {
  const { rows } = await client.query<{
    status: string;
    agent_run_id: string | null;
    event_from_id: string | null;
    event_to_id: string | null;
  }>(
    `SELECT status, agent_run_id, event_from_id, event_to_id FROM semp_messages
     WHERE thread_id = $1 AND id = $2 AND role = 'assistant'`,
    [threadId, assistantMessageId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    status: assertKnownValue(["queued", "running", "done", "error"] as const, row.status, "message status"),
    runId: row.agent_run_id,
    firstEventId: row.event_from_id,
    lastEventId: row.event_to_id,
  };
}

export async function getSempMessageToken(client: PoolClient, messageId: string): Promise<string | null> {
  const { rows } = await client.query<{ token: string }>(
    `SELECT ${MESSAGE_TOKEN} AS token FROM semp_messages WHERE id = $1`,
    [messageId],
  );
  return rows[0]?.token ?? null;
}

export async function getSempMessageFrontier(
  client: PoolClient,
  threadId: string,
  sourceId: string,
  assistantId: string,
): Promise<string | null> {
  const { rows } = await client.query<{ token: string }>(
    `SELECT ${MESSAGE_TOKEN} AS token FROM semp_messages WHERE thread_id = $1 AND id <> $2 AND id <> $3
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [threadId, sourceId, assistantId],
  );
  return rows[0]?.token ?? null;
}

export async function claimSempMessage(client: PoolClient, threadId: string, messageId: string): Promise<boolean> {
  requireManagedTransaction(client);
  const result = await client.query(
    "UPDATE semp_messages SET status = 'running', updated_at = now() WHERE thread_id = $1 AND id = $2 AND role = 'assistant' AND status = 'queued'",
    [threadId, messageId],
  );
  return result.rowCount === 1;
}

export async function startSempMessageTurn(
  client: PoolClient,
  messageId: string,
  agentRunId: string,
  firstEventId: string,
): Promise<void> {
  requireManagedTransaction(client);
  const result = await client.query(
    "UPDATE semp_messages SET agent_run_id = $2, event_from_id = $3::bigint, updated_at = now() WHERE id = $1 AND status = 'running'",
    [messageId, agentRunId, firstEventId],
  );
  requireAffectedRows(result, "starting Semp message turn");
}

export async function finishSempMessageTurn(
  client: PoolClient,
  messageId: string,
  outcome: { status: "done"; text: string | null; lastEventId: string } | { status: "error"; interrupted?: boolean },
): Promise<boolean> {
  requireManagedTransaction(client);
  const result = await client.query(
    "UPDATE semp_messages SET status = $2, text = $3, event_to_id = $4::bigint, error_code = $5, updated_at = now() WHERE id = $1 AND status = 'running'",
    [
      messageId,
      outcome.status,
      outcome.status === "done" ? outcome.text : null,
      outcome.status === "done" ? outcome.lastEventId : null,
      outcome.status === "error" && outcome.interrupted ? "interrupted" : null,
    ],
  );
  return result.rowCount === 1;
}

export async function repairInterruptedSempMessages(client: PoolClient): Promise<number> {
  requireManagedTransaction(client);
  const scope = currentTenantScope();
  if (scope?.kind !== "tenant") throw new Error("Semp message repair requires a tenant scope");
  const repaired = await client.query<{ thread_id: string }>(
    "UPDATE semp_messages SET status = 'error', error_code = 'interrupted', updated_at = now() WHERE role = 'assistant' AND status = 'running' RETURNING thread_id",
  );
  if (repaired.rowCount !== repaired.rows.length) throw new Error("Semp repair returned an inconsistent row count");
  for (const threadId of [...new Set(repaired.rows.map((row) => row.thread_id))].sort()) {
    const updated = await client.query(
      "UPDATE semp_threads SET last_activity_at = GREATEST(last_activity_at, now()) WHERE id = $1",
      [threadId],
    );
    requireAffectedRows(updated, "updating repaired Semp thread activity");
    publishSempThreadInvalidation(client, scope.tenantId, threadId);
  }
  return repaired.rows.length;
}

export async function insertApprovalOutcomeSystemMessage(
  client: PoolClient,
  threadId: string,
  requestId: string,
  key: string,
  params: Record<string, string | number | null>,
): Promise<void> {
  requireManagedTransaction(client);
  const createdAt = await allocateSempMessageTimestamp(client, threadId);
  const inserted = await client.query(
    `INSERT INTO semp_messages (thread_id, role, system_key, system_params, context, created_at)
     VALUES ($1, 'system', $2, $3::jsonb, $4::jsonb, $5::timestamptz)`,
    [
      threadId,
      key,
      JSON.stringify(params),
      JSON.stringify([{ kind: "approvalRequest", approvalRequestId: requestId }]),
      createdAt,
    ],
  );
  requireAffectedRows(inserted, "inserting approval outcome message");
  const result = await client.query(
    "UPDATE semp_threads SET last_activity_at = GREATEST(last_activity_at, now()) WHERE id = $1",
    [threadId],
  );
  requireAffectedRows(result, `updating thread '${threadId}' activity`);
}
