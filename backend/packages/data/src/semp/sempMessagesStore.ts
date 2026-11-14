import type { Pool, PoolClient } from "pg";
import { requireAffectedRows, requireManagedTransaction, requireSingleRow } from "../db/pool.js";
import { assertKnownValue } from "../dbRowValidation.js";
import { ChokePointError, NotFoundError } from "../errors.js";
import { guardInboxThreadSend } from "../inbox/inboxThreadSendGuard.js";
import { replyOutcomeOfStoredSteps } from "../agentRuns/replyOutcome.js";
import { parseStoredSempReplySteps } from "./sempStoredSteps.js";
import { allocateSempMessageTimestamp } from "./sempMessageOrder.js";
import { currentTenantScope } from "@semprec/shared";
import { publishSempThreadInvalidation } from "../realtimeHook.js";
import { raiseAgentReplyProblem } from "./agentReplyProblems.js";
import { enqueueSempMessage } from "./sempMessageQueue.js";
import { sempMessageSearchVectorSql } from "./sempMessageSearch.js";
import type { SempReplySummary } from "./sempReplySummary.js";
import type { AgentRunErrorCode } from "../agentRuns/agentRunErrorCodes.js";
import { parseSempReplyErrorCode, type SempReplyErrorParams } from "./sempReplyErrors.js";

// A fixed SQL fragment; no caller input is interpolated.
const MESSAGE_TOKEN = `jsonb_build_object('id', id, 'role', role, 'text', text, 'status', status,
  'context', context, 'systemKey', system_key, 'systemParams', system_params,
  'replyTo', reply_to_message_id, 'run', agent_run_id, 'from', event_from_id, 'to', event_to_id,
  'errorCode', error_code, 'replacedBy', replaced_by_message_id, 'createdAt', created_at, 'updatedAt', updated_at)::text`;

/** Reads the queued assistant for one thread turn under the current tenant; `errorCode` is set for an `error` reply only. */
export async function getSempVoiceDelivery(client: Pool | PoolClient, threadId: string, assistantMessageId: string) {
  const { rows } = await client.query<{
    status: string;
    agent_run_id: string | null;
    event_from_id: string | null;
    event_to_id: string | null;
    error_code: string | null;
  }>(
    `SELECT status, agent_run_id, event_from_id, event_to_id, error_code FROM semp_messages
     WHERE thread_id = $1 AND id = $2 AND role = 'assistant'`,
    [threadId, assistantMessageId],
  );
  const row = rows[0];
  if (!row) return null;
  const status = assertKnownValue(["queued", "running", "done", "error"] as const, row.status, "message status");
  return {
    status,
    runId: row.agent_run_id,
    firstEventId: row.event_from_id,
    lastEventId: row.event_to_id,
    errorCode: status === "error" ? parseSempReplyErrorCode(row.error_code) : null,
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

/**
 * Stores the final status of a running assistant message. `summary` (issues #1860 and #1885) is the steps,
 * duration, token totals and changed items of the turn and is written by the same statement as the status, so a
 * message never has a final status without the summary the caller built for it; a caller that has none leaves the
 * four columns NULL.
 * A failed turn stores its `errorCode` and `errorParams` (issue #1907) by that same statement; `errorCode` is
 * optional only for a caller that has no classification (a message closed without a turn), which leaves the
 * columns NULL and reads back as `internal`.
 * Returns false when the message is no longer `running`, in which case nothing is written.
 */
export async function finishSempMessageTurn(
  client: PoolClient,
  messageId: string,
  outcome:
    | { status: "done"; text: string | null; lastEventId: string; summary?: SempReplySummary }
    | {
        status: "error";
        errorCode?: AgentRunErrorCode;
        errorParams?: SempReplyErrorParams;
        summary?: SempReplySummary;
      },
): Promise<boolean> {
  requireManagedTransaction(client);
  const summary = outcome.summary;
  const result = await client.query(
    `UPDATE semp_messages SET status = $2, text = $3::text, search_vector = ${sempMessageSearchVectorSql("$3::text")},
       event_to_id = $4::bigint, error_code = $5, error_params = $10::jsonb,
       steps = $6::jsonb, duration_ms = $7::integer, tokens = $8::jsonb, changes = $9::jsonb, updated_at = now()
     WHERE id = $1 AND status = 'running'`,
    [
      messageId,
      outcome.status,
      outcome.status === "done" ? outcome.text : null,
      outcome.status === "done" ? outcome.lastEventId : null,
      outcome.status === "error" ? (outcome.errorCode ?? null) : null,
      summary ? JSON.stringify(summary.steps) : null,
      summary?.durationMs ?? null,
      summary ? JSON.stringify(summary.tokens) : null,
      summary ? JSON.stringify(summary.changes) : null,
      outcome.status === "error" && outcome.errorParams ? JSON.stringify(outcome.errorParams) : null,
    ],
  );
  return result.rowCount === 1;
}

/**
 * Closes every `running` assistant message of the current tenant as `error` / `interrupted`, the state a turn is
 * left in when its process died, and raises the problem of each reply in the same transaction (issue #1931), as
 * the turn handler does for a turn it interrupted itself. Returns the number of messages closed.
 */
export async function repairInterruptedSempMessages(client: PoolClient): Promise<number> {
  requireManagedTransaction(client);
  const scope = currentTenantScope();
  if (scope?.kind !== "tenant") throw new Error("Semp message repair requires a tenant scope");
  const repaired = await client.query<{ id: string; thread_id: string }>(
    "UPDATE semp_messages SET status = 'error', error_code = 'interrupted', updated_at = now() WHERE role = 'assistant' AND status = 'running' RETURNING id, thread_id",
  );
  if (repaired.rowCount !== repaired.rows.length) throw new Error("Semp repair returned an inconsistent row count");
  for (const messageId of repaired.rows.map((row) => row.id).sort()) {
    await raiseAgentReplyProblem(client, messageId);
  }
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
  const heartbeat = await client.query<{ id: string }>(
    `SELECT h.id FROM semp_threads t
       JOIN project_heartbeats h ON h.tenant_id = t.tenant_id AND h.id = t.heartbeat_id
      WHERE t.id = $1 AND t.kind = 'tick' AND h.enabled = true FOR UPDATE OF h`,
    [threadId],
  );
  const createdAt = await allocateSempMessageTimestamp(client, threadId);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO semp_messages (thread_id, role, system_key, system_params, context, created_at)
     VALUES ($1, 'system', $2, $3::jsonb, $4::jsonb, $5::timestamptz) RETURNING id`,
    [
      threadId,
      key,
      JSON.stringify(params),
      JSON.stringify([{ kind: "approvalRequest", approvalRequestId: requestId }]),
      createdAt,
    ],
  );
  requireAffectedRows(inserted, "inserting approval outcome message");
  const sourceId = inserted.rows[0]?.id;
  if (!sourceId) throw new Error("Approval outcome message has no id");
  if (heartbeat.rows.length > 0) {
    const assistantTimestamp = await allocateSempMessageTimestamp(client, threadId);
    const assistant = await client.query<{ id: string }>(
      `INSERT INTO semp_messages (thread_id, role, reply_to_message_id, status, created_at)
       VALUES ($1, 'assistant', $2, 'queued', $3::timestamptz) RETURNING id`,
      [threadId, sourceId, assistantTimestamp],
    );
    const assistantMessageId = assistant.rows[0]?.id;
    if (!assistantMessageId) throw new Error("Approval continuation has no id");
    await enqueueSempMessage(client, { threadId, assistantMessageId });
  }
  const result = await client.query(
    "UPDATE semp_threads SET last_activity_at = GREATEST(last_activity_at, now()) WHERE id = $1",
    [threadId],
  );
  requireAffectedRows(result, `updating thread '${threadId}' activity`);
}

/** Raised when a retry is asked for a message that is not the latest failed or incomplete assistant reply of its thread (issue gh-1926). */
export class SempRetryNotLatestError extends ChokePointError {
  constructor() {
    super(409, "retry_not_latest", "Only the latest failed or incomplete reply of a thread can be retried");
    this.name = "SempRetryNotLatestError";
  }
}

/** The codes of a refused regeneration (issue gh-1930), each with the reason `SempRegenerateRefusedError` carries. */
const SEMP_REGENERATE_REFUSALS = {
  regenerate_not_latest: "Only the latest finished reply of a thread can be regenerated",
  regenerate_after_writes: "A reply whose turn made changes or requested an approval cannot be regenerated",
  regenerate_after_compaction:
    "A reply that a compaction checkpoint of the thread already includes cannot be regenerated",
} as const;

/** Raised when a regeneration is refused (issue gh-1930); `code` is the closed code of the REST error contract. */
export class SempRegenerateRefusedError extends ChokePointError {
  constructor(code: keyof typeof SEMP_REGENERATE_REFUSALS) {
    super(409, code, SEMP_REGENERATE_REFUSALS[code]);
    this.name = "SempRegenerateRefusedError";
  }
}

interface SempThreadSubject {
  kind: "chat" | "item" | "tick";
  subjectInboxItemId: string | null;
}

/** Reads the kind and Inbox subject of a thread, under its row lock when `lock` is set. Not visible is `NotFoundError`. */
async function readSempThreadSubject(client: PoolClient, threadId: string, lock: boolean): Promise<SempThreadSubject> {
  const found = await client.query<{ kind: string; subject_inbox_item_id: string | null }>(
    `SELECT kind, subject_inbox_item_id FROM semp_threads WHERE id = $1${lock ? " FOR UPDATE" : ""}`,
    [threadId],
  );
  const row = found.rows[0];
  if (!row) throw new NotFoundError("Thread not found");
  return {
    kind: assertKnownValue(["chat", "item", "tick"] as const, row.kind, "thread kind"),
    subjectInboxItemId: row.subject_inbox_item_id,
  };
}

function requireItemSubject(subject: SempThreadSubject): string {
  if (!subject.subjectInboxItemId) throw new Error("Item thread has no Inbox subject");
  return subject.subjectInboxItemId;
}

interface LockedReply {
  role: string;
  status: string | null;
  reply_to_message_id: string | null;
  attempt: number;
  steps: unknown;
  changes: unknown;
  agent_run_id: string | null;
  event_from_id: string | null;
  event_to_id: string | null;
  is_latest: boolean;
}

/**
 * Takes the thread's row lock, the lock every insert of a message of the thread takes, and then the row lock of the
 * message `messageId`, and reads the message with whether it is the latest message of the thread (the order of the
 * history: `created_at`, then `id`). With the lock held, the latest message of the thread cannot change until the
 * transaction ends. A thread, or a message of it, that is not visible in the tenant scope is `NotFoundError`, the
 * same answer as for an id that does not exist.
 *
 * A reply queues a new turn, as a sent message does, so an item thread passes the send guard first
 * (`guardInboxThreadSend`): the Inbox source and the proposal cards are locked and a decided proposal is refused with
 * `ProposalLockedError`, which comes before every check of the reply itself. The guard runs before the thread's lock,
 * the order `sendSempMessage` takes, so a retry or a regeneration and a proposal decision cannot wait on each other
 * in opposite orders. The kind and subject read for it are read again under the lock, and a thread that changed in
 * between is `NotFoundError`.
 */
async function lockSempReply(client: PoolClient, threadId: string, messageId: string): Promise<LockedReply> {
  const subject = await readSempThreadSubject(client, threadId, false);
  if (subject.kind === "item") await guardInboxThreadSend(client, requireItemSubject(subject));
  const locked = await readSempThreadSubject(client, threadId, true);
  if (locked.kind !== subject.kind || locked.subjectInboxItemId !== subject.subjectInboxItemId) {
    throw new NotFoundError("Thread not found");
  }
  const found = await client.query<LockedReply>(
    `SELECT m.role, m.status, m.reply_to_message_id, m.attempt, m.steps, m.changes, m.agent_run_id, m.event_from_id,
            m.event_to_id,
            m.id = (SELECT l.id FROM semp_messages l WHERE l.thread_id = m.thread_id
                     ORDER BY l.created_at DESC, l.id DESC LIMIT 1) AS is_latest
       FROM semp_messages m WHERE m.thread_id = $1 AND m.id = $2 FOR UPDATE OF m`,
    [threadId, messageId],
  );
  const message = found.rows[0];
  if (!message) throw new NotFoundError("Message not found");
  return message;
}

/**
 * Inserts the next attempt at the reply that `previous` answers, in status `queued`, as the send path inserts an
 * assistant message, and enqueues its turn in the same transaction, so a committed attempt always has a job and a
 * rolled-back one has none. The unique index `semp_messages_reply_attempt_uq` is the second line behind the thread
 * lock the caller holds.
 */
async function queueNextSempReplyAttempt(
  client: PoolClient,
  threadId: string,
  previous: { replyToMessageId: string; attempt: number },
): Promise<string> {
  const createdAt = await allocateSempMessageTimestamp(client, threadId);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO semp_messages (thread_id, role, reply_to_message_id, status, attempt, created_at)
     VALUES ($1, 'assistant', $2, 'queued', $3, $4::timestamptz) RETURNING id`,
    [threadId, previous.replyToMessageId, previous.attempt + 1, createdAt],
  );
  const assistantMessageId = requireSingleRow(inserted.rows, "inserting Semp reply attempt").id;
  const updated = await client.query(
    "UPDATE semp_threads SET last_activity_at = GREATEST(last_activity_at, now()) WHERE id = $1",
    [threadId],
  );
  requireAffectedRows(updated, "updating Semp thread activity");
  await enqueueSempMessage(client, { threadId, assistantMessageId });
  return assistantMessageId;
}

/**
 * Queues another attempt of the assistant reply `messageId` of thread `threadId` (issue gh-1926) and returns the id
 * of the new assistant message. The message is retryable when it is the latest message of the thread, an assistant
 * message with a stored `reply_to_message_id` and either `error`, or `done` with an incomplete reply
 * (`replyOutcomeOfStoredSteps`, issue #1890). Anything else is `SempRetryNotLatestError`. Under the thread's row lock
 * a second retry of the same reply, which waited for the lock, finds the new attempt as the latest message and is
 * refused. The new message answers the same message as the retried one with `attempt` + 1. A retry queues a turn as a
 * sent message does, so on an item thread it passes the send guard of the path it reuses first and is refused with
 * `ProposalLockedError` once a proposal of the Inbox item is decided (`lockSempReply`).
 */
export async function retrySempReply(
  client: PoolClient,
  threadId: string,
  messageId: string,
): Promise<{ messageId: string }> {
  requireManagedTransaction(client);
  const message = await lockSempReply(client, threadId, messageId);
  if (!message.is_latest || message.role !== "assistant" || message.reply_to_message_id === null) {
    throw new SempRetryNotLatestError();
  }
  const status = assertKnownValue(
    ["queued", "running", "done", "error"] as const,
    message.status ?? "",
    "message status",
  );
  if (status !== "error" && !(status === "done" && replyOutcomeOfStoredSteps(message.steps).outcome === "incomplete")) {
    throw new SempRetryNotLatestError();
  }
  const assistantMessageId = await queueNextSempReplyAttempt(client, threadId, {
    replyToMessageId: message.reply_to_message_id,
    attempt: message.attempt,
  });
  return { messageId: assistantMessageId };
}

/**
 * Whether the turn of a finished reply wrote something or asked to: its stored `changes` are not an empty list (a
 * reply stored without them, before issue #1885, is not known to have made none), a stored step carries an approval
 * request, or an approval request of its run belongs to a tool call of the reply, by the `toolCallId` of a stored
 * step or of a `tool_use` event in the reply's range (events are removed by retention, steps are not). An approval
 * request stored without a tool call id belongs to no reply (`getAgentRunDetail`).
 */
async function sempReplyWroteOrAsked(
  client: PoolClient,
  reply: LockedReply & { agent_run_id: string; event_from_id: string; event_to_id: string },
): Promise<boolean> {
  if (!Array.isArray(reply.changes) || reply.changes.length > 0) return true;
  const steps = parseStoredSempReplySteps(reply.steps) ?? [];
  if (steps.some((step) => step.approvalRequestId !== undefined)) return true;
  const requested = await client.query<{ requested: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM approval_requests ar
        WHERE ar.agent_run_id = $1 AND ar.tool_call_id IS NOT NULL
          AND (ar.tool_call_id = ANY($4::text[]) OR EXISTS (
            SELECT 1 FROM agent_run_events e
             WHERE e.agent_run_id = ar.agent_run_id AND e.kind = 'tool_use'
               AND e.id BETWEEN $2::bigint AND $3::bigint AND e.payload->>'toolCallId' = ar.tool_call_id))
     ) AS requested`,
    [
      reply.agent_run_id,
      reply.event_from_id,
      reply.event_to_id,
      steps.flatMap((step) => (step.toolCallId === undefined ? [] : [step.toolCallId])),
    ],
  );
  return requireSingleRow(requested.rows, "reading the approval requests of a Semp reply").requested;
}

/**
 * Queues the next attempt at the latest finished reply `messageId` of thread `threadId` in place of it (issue
 * gh-1930) and returns the id of the new assistant message. The old reply stays stored with its steps; it gets
 * `replaced_by_message_id`, which hides the events of its turn from the history a later wake rebuilds
 * (`listSessionAgentRunEventsFromLastCompaction`). On an item thread the send guard runs before all of this and
 * refuses a decided proposal with `ProposalLockedError` (`lockSempReply`). The checks run in this order under the
 * thread's row lock, and the first that fails is raised as `SempRegenerateRefusedError`:
 *
 * 1. `regenerate_not_latest`: the message is not the latest message of the thread, not an assistant message with
 *    status `done` that answers a message, or has no run range to hide (no run or no event ids stored).
 * 2. `regenerate_after_writes`: the turn wrote or asked to (`sempReplyWroteOrAsked`).
 * 3. `regenerate_after_compaction`: a `compaction` event of the thread's conversation has an id above the reply's
 *    `event_to_id`, so the reply is already folded into a checkpoint and cannot be removed from it.
 *
 * The turn of the new attempt is enqueued in the same transaction. A live session that holds the replaced answer in
 * memory is dropped by the turn handler: the replaced message is the latest message the new turn sees besides its
 * own source and reply, its `replacedBy` is part of the token of `getSempMessageToken`, and the session cached the
 * token it had before, so `SempConversation.ensureFresh` finds it stale and pauses it
 * (`2026-11-06-semp-message-order-and-session-freshness`).
 */
export async function regenerateSempReply(
  client: PoolClient,
  threadId: string,
  messageId: string,
): Promise<{ messageId: string }> {
  requireManagedTransaction(client);
  const message = await lockSempReply(client, threadId, messageId);
  const refuse = (code: keyof typeof SEMP_REGENERATE_REFUSALS) => new SempRegenerateRefusedError(code);
  if (!message.is_latest || message.role !== "assistant" || message.reply_to_message_id === null) {
    throw refuse("regenerate_not_latest");
  }
  const status = assertKnownValue(
    ["queued", "running", "done", "error"] as const,
    message.status ?? "",
    "message status",
  );
  const { agent_run_id: runId, event_from_id: fromId, event_to_id: toId } = message;
  if (status !== "done" || runId === null || fromId === null || toId === null) throw refuse("regenerate_not_latest");
  if (
    await sempReplyWroteOrAsked(client, { ...message, agent_run_id: runId, event_from_id: fromId, event_to_id: toId })
  ) {
    throw refuse("regenerate_after_writes");
  }
  const compacted = await client.query<{ compacted: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM agent_run_events e JOIN agent_runs r ON r.tenant_id = e.tenant_id AND r.id = e.agent_run_id
        WHERE r.thread_id = $1 AND r.unit = 'session' AND r.triggered_by = 'user' AND r.parent_run_id IS NULL
          AND e.kind = 'compaction' AND e.id > $2::bigint) AS compacted`,
    [threadId, toId],
  );
  if (requireSingleRow(compacted.rows, "reading the compaction checkpoints of a Semp thread").compacted) {
    throw refuse("regenerate_after_compaction");
  }
  const assistantMessageId = await queueNextSempReplyAttempt(client, threadId, {
    replyToMessageId: message.reply_to_message_id,
    attempt: message.attempt,
  });
  const replaced = await client.query(
    `UPDATE semp_messages SET replaced_by_message_id = $2, updated_at = now()
      WHERE id = $1 AND replaced_by_message_id IS NULL`,
    [messageId, assistantMessageId],
  );
  requireAffectedRows(replaced, "marking a Semp reply as replaced");
  return { messageId: assistantMessageId };
}
