import type { PoolClient } from "pg";
import { requireAffectedRows, requireManagedTransaction, requireSingleRow } from "../db/pool.js";
import { enqueueSempMessage } from "../semp/sempMessageQueue.js";
import { allocateSempMessageTimestamp } from "../semp/sempMessageOrder.js";
import { assertKnownValue } from "../dbRowValidation.js";
import type { SempThreadDetail, SempThreadMessage, SempTickThreadHeartbeat } from "@semprec/shared";
import { getItemsByIds } from "../chokePoint/itemsStore.js";
import { isOnItemEventRule, parseHeartbeatRule, type HeartbeatRuleKindRegistry } from "../scheduler/rule.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { guardInboxThreadSend } from "../inbox/inboxThreadSendGuard.js";
import { resolveSempHistoryContexts } from "../semp/sempRefHistory.js";
import { resolveSempHistoryChanges } from "../semp/sempChangeHistory.js";
import type { SempReplyStep } from "../semp/sempReplySteps.js";
import { parseStoredSempReplySteps } from "../semp/sempStoredSteps.js";
import { sempMessageSearchVectorSql } from "../semp/sempMessageSearch.js";
import { deriveReplyOutcome, type ReplyOutcome } from "../agentRuns/replyOutcome.js";
import { parseSempReplyErrorCode, parseSempReplyErrorParams, renderSempReplyFailure } from "../semp/sempReplyErrors.js";

interface ThreadRow {
  id: string;
  kind: string;
  title: string | null;
  subject_inbox_item_id: string | null;
  subject_proposal_id: string | null;
  created_at: Date;
  last_activity_at: Date;
  /** The `project_heartbeats` columns of a tick thread's heartbeat; all null without one. */
  heartbeat_row_id: string | null;
  heartbeat_name: string | null;
  heartbeat_rule: unknown;
  heartbeat_enabled: boolean | null;
  heartbeat_project_item_id: string | null;
}

interface MessageRow {
  id: string;
  role: string;
  text: string | null;
  system_key: string | null;
  system_params: unknown;
  context: unknown;
  changes: unknown;
  reply_to_message_id: string | null;
  agent_run_id: string | null;
  event_from_id: string | null;
  status: string | null;
  steps: unknown;
  error_code: string | null;
  error_params: unknown;
  created_at: string;
  run_started_at: Date | null;
  run_finished_at: Date | null;
  run_status: string | null;
  /** The language of the tenant's user (`users.locale`), read by the same statement as the page. */
  user_locale: string | null;
}

export async function createSempChatThread(client: PoolClient): Promise<string> {
  requireManagedTransaction(client);
  const result = await client.query<{ id: string }>("INSERT INTO semp_threads (kind) VALUES ('chat') RETURNING id");
  return requireSingleRow(result.rows, "creating Semp chat thread").id;
}

export async function getSempMessageTurn(client: PoolClient, threadId: string, messageId: string) {
  const { rows } = await client.query<{
    kind: string;
    heartbeat_id: string | null;
    subject_inbox_item_id: string | null;
    project_item_id: string | null;
    role: string;
    source_id: string;
    text: string | null;
    context: unknown;
    system_key: string | null;
    heartbeat_enabled: boolean | null;
  }>(
    `SELECT t.kind, t.heartbeat_id, t.subject_inbox_item_id, h.project_item_id, h.enabled AS heartbeat_enabled,
            source.id AS source_id, source.role, source.text, source.context, source.system_key
       FROM semp_messages reply
       JOIN semp_threads t ON t.tenant_id = reply.tenant_id AND t.id = reply.thread_id
       JOIN semp_messages source ON source.tenant_id = reply.tenant_id AND source.id = reply.reply_to_message_id
         AND source.thread_id = reply.thread_id
       LEFT JOIN project_heartbeats h ON h.tenant_id = t.tenant_id AND h.id = t.heartbeat_id
      WHERE reply.id = $1 AND reply.thread_id = $2 AND reply.role = 'assistant'`,
    [messageId, threadId],
  );
  const row = rows[0];
  if (!row) return null;
  let outcome: { kind: "executed" | "rejected" | "conflict"; result: unknown } | null = null;
  if (row.role === "system" && row.text === null) {
    if (row.kind !== "tick" || !Array.isArray(row.context) || row.context.length !== 1) {
      throw new Error("Invalid approval outcome source");
    }
    const entry: unknown = row.context[0];
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("kind" in entry) ||
      entry.kind !== "approvalRequest" ||
      !("approvalRequestId" in entry) ||
      typeof entry.approvalRequestId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.approvalRequestId)
    ) {
      throw new Error("Invalid approval outcome context");
    }
    const kind = assertKnownValue(
      ["approval.outcome.executed", "approval.outcome.rejected", "approval.outcome.conflict"] as const,
      row.system_key ?? "",
      "approval outcome key",
    );
    const result = await client.query<{ status: string; execution_status: string; execution_result_jsonb: unknown }>(
      `SELECT a.status, a.execution_status, a.execution_result_jsonb FROM approval_requests a
       JOIN agent_runs r ON r.tenant_id = a.tenant_id AND r.id = a.agent_run_id
       WHERE a.id = $1 AND r.thread_id = $2
         AND (r.heartbeat_id = $3 OR
           (r.heartbeat_id IS NULL AND r.unit = 'session' AND r.triggered_by = 'user'))`,
      [entry.approvalRequestId, threadId, row.heartbeat_id],
    );
    const request = result.rows[0];
    if (
      !request ||
      (kind === "approval.outcome.rejected"
        ? request.status !== "rejected"
        : request.status !== "approved" ||
          request.execution_status !== (kind === "approval.outcome.executed" ? "succeeded" : "conflict"))
    ) {
      throw new Error("Approval outcome provenance mismatch");
    }
    outcome = {
      kind:
        kind === "approval.outcome.executed"
          ? "executed"
          : kind === "approval.outcome.rejected"
            ? "rejected"
            : "conflict",
      result: request.execution_result_jsonb,
    };
  }
  return {
    kind: assertKnownValue(["chat", "item", "tick"] as const, row.kind, "thread kind"),
    heartbeatId: row.heartbeat_id,
    subjectInboxItemId: row.subject_inbox_item_id,
    projectItemId: row.project_item_id,
    role: assertKnownValue(["user", "system"] as const, row.role, "source message role"),
    sourceId: row.source_id,
    text: row.text,
    context: row.context,
    heartbeatEnabled: row.heartbeat_enabled === true,
    outcome,
  };
}

export async function insertSempUserTurn(
  client: PoolClient,
  threadId: string,
  text: string,
  context: unknown,
  trusted?: { source: "voice" },
): Promise<{ threadId: string; messageId: string; assistantMessageId: string }> {
  requireManagedTransaction(client);
  const userTimestamp = await allocateSempMessageTimestamp(client, threadId);
  const user = await client.query<{ id: string }>(
    `INSERT INTO semp_messages (thread_id, role, text, search_vector, context, created_at, source)
     VALUES ($1, 'user', $2::text, ${sempMessageSearchVectorSql("$2::text")}, $3::jsonb, $4::timestamptz, $5)
     RETURNING id`,
    [threadId, text, JSON.stringify(context), userTimestamp, trusted?.source ?? null],
  );
  const messageId = requireSingleRow(user.rows, "inserting Semp user message").id;
  const assistantTimestamp = await allocateSempMessageTimestamp(client, threadId);
  const assistant = await client.query<{ id: string }>(
    "INSERT INTO semp_messages (thread_id, role, reply_to_message_id, status, created_at) VALUES ($1, 'assistant', $2, 'queued', $3::timestamptz) RETURNING id",
    [threadId, messageId, assistantTimestamp],
  );
  const assistantMessageId = requireSingleRow(assistant.rows, "inserting Semp assistant message").id;
  const updated = await client.query(
    "UPDATE semp_threads SET last_activity_at = GREATEST(last_activity_at, now()) WHERE id = $1",
    [threadId],
  );
  requireAffectedRows(updated, "updating Semp thread activity");
  await enqueueSempMessage(client, { threadId, assistantMessageId });
  return { threadId, messageId, assistantMessageId };
}

export async function sendSempMessage(
  client: PoolClient,
  input: {
    threadId?: string;
    subject?: { inboxItemId: string; proposalId?: string };
    text: string;
    context: unknown;
    hasContext: boolean;
  },
  trusted?: { source: "voice" },
) {
  requireManagedTransaction(client);
  let threadId = input.threadId;
  let subject = input.subject;
  let originalKind: "chat" | "item" | "tick" | undefined;
  if (threadId) {
    const existing = await client.query<{ kind: string; subject_inbox_item_id: string | null }>(
      "SELECT kind, subject_inbox_item_id FROM semp_threads WHERE id = $1",
      [threadId],
    );
    const row = existing.rows[0];
    if (!row) throw new NotFoundError("Thread not found");
    const kind = assertKnownValue(["chat", "item", "tick"] as const, row.kind, "thread kind");
    originalKind = kind;
    if (kind === "item") {
      if (!row.subject_inbox_item_id) throw new Error("Item thread has no Inbox subject");
      subject = { inboxItemId: row.subject_inbox_item_id };
    }
  }
  if (subject) {
    if (input.hasContext) throw new ValidationError("Context is only supported for chat threads", { field: "context" });
    await guardInboxThreadSend(client, subject.inboxItemId, subject.proposalId);
    if (!threadId) {
      const result = await client.query<{ id: string }>(
        `INSERT INTO semp_threads (kind, subject_inbox_item_id, subject_proposal_id)
         VALUES ('item', $1, $2) ON CONFLICT (tenant_id, subject_inbox_item_id) WHERE kind = 'item'
         DO NOTHING RETURNING id`,
        [subject.inboxItemId, subject.proposalId ?? null],
      );
      threadId = result.rows[0]?.id;
      if (!threadId) {
        const existing = await client.query<{ id: string }>(
          "SELECT id FROM semp_threads WHERE kind = 'item' AND subject_inbox_item_id = $1",
          [subject.inboxItemId],
        );
        threadId = requireSingleRow(existing.rows, "finding item thread").id;
      }
    }
  } else if (!threadId) {
    threadId = await createSempChatThread(client);
  }
  const locked = await client.query<{ kind: string; subject_inbox_item_id: string | null }>(
    "SELECT kind, subject_inbox_item_id FROM semp_threads WHERE id = $1 FOR UPDATE",
    [threadId],
  );
  const row = locked.rows[0];
  if (!row) throw new NotFoundError("Thread not found");
  const kind = assertKnownValue(["chat", "item", "tick"] as const, row.kind, "thread kind");
  if (originalKind && kind !== originalKind) throw new NotFoundError("Thread not found");
  if (subject && (kind !== "item" || row.subject_inbox_item_id !== subject.inboxItemId)) {
    throw new NotFoundError("Thread not found");
  }
  if (kind !== "chat" && input.hasContext) {
    throw new ValidationError("Context is only supported for chat threads", { field: "context" });
  }
  return insertSempUserTurn(client, threadId, input.text, input.context, trusted);
}

/**
 * The automation header and the running run of a tick thread (issue #1562). The rule is validated against
 * `moduleRuleKinds`, the rule kinds of the active modules, as the scheduler validates it. The heartbeat
 * comes from a left join; `semp_threads.heartbeat_id` references it `ON DELETE RESTRICT`
 * (`0087_semp_threads_and_messages.sql`), so no ordinary path leaves a tick thread without its heartbeat
 * and the `heartbeat: null` branch is defensive. The project name is read only from a live project item.
 */
async function readTickThreadHeader(
  client: PoolClient,
  row: ThreadRow,
  moduleRuleKinds: HeartbeatRuleKindRegistry,
): Promise<Pick<SempThreadDetail, "heartbeat" | "activeRun">> {
  let heartbeat: SempTickThreadHeartbeat | null = null;
  if (row.heartbeat_project_item_id !== null && row.heartbeat_row_id !== null) {
    const rule = parseHeartbeatRule(row.heartbeat_rule, moduleRuleKinds);
    const [project] = await getItemsByIds(client, [row.heartbeat_project_item_id]);
    const projectName = project?.properties.name;
    heartbeat = {
      id: row.heartbeat_row_id,
      name: requireValue(row.heartbeat_name, "heartbeat name"),
      rule,
      enabled: requireValue(row.heartbeat_enabled, "heartbeat enabled"),
      projectItemId: row.heartbeat_project_item_id,
      projectName: typeof projectName === "string" ? projectName : null,
      canTrigger: row.heartbeat_enabled === true && !isOnItemEventRule(rule),
    };
  }
  // The latest running run, so the choice is deterministic should more than one be running.
  const runs = await client.query<{ id: string; started_at: Date }>(
    `SELECT id, started_at FROM agent_runs WHERE thread_id = $1 AND status = 'running'
      ORDER BY started_at DESC, id DESC LIMIT 1`,
    [row.id],
  );
  const run = runs.rows[0];
  return { heartbeat, activeRun: run ? { agentRunId: run.id, startedAt: run.started_at.toISOString() } : null };
}

function requireValue<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(`Joined ${label} is missing`);
  return value;
}

/**
 * The detail of one Semp thread of the current tenant, or null when it is not visible. A tick thread
 * also carries its heartbeat header and active run (issue #1562); other kinds carry neither key.
 * `moduleRuleKinds` is the active modules' rule-kind registry (`resolveModuleRuleKinds`); a rule kind that
 * is neither core nor registered there is refused, as the scheduler refuses it.
 */
export async function getSempThread(
  client: PoolClient,
  id: string,
  moduleRuleKinds: HeartbeatRuleKindRegistry,
): Promise<SempThreadDetail | null> {
  const { rows } = await client.query<ThreadRow>(
    `SELECT t.id, t.kind, t.title, t.subject_inbox_item_id, t.subject_proposal_id, t.created_at, t.last_activity_at,
            h.id AS heartbeat_row_id, h.name AS heartbeat_name, h.rule AS heartbeat_rule,
            h.enabled AS heartbeat_enabled, h.project_item_id AS heartbeat_project_item_id
       FROM semp_threads t
       LEFT JOIN project_heartbeats h ON h.tenant_id = t.tenant_id AND h.id = t.heartbeat_id
      WHERE t.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  const kind = assertKnownValue(["chat", "item", "tick"] as const, row.kind, "thread kind");
  const detail: SempThreadDetail = {
    id: row.id,
    kind,
    title: row.title,
    subject: kind === "item" ? { inboxItemId: row.subject_inbox_item_id, proposalId: row.subject_proposal_id } : null,
    createdAt: row.created_at.toISOString(),
    lastActivityAt: row.last_activity_at.toISOString(),
  };
  return kind === "tick" ? { ...detail, ...(await readTickThreadHeader(client, row, moduleRuleKinds)) } : detail;
}

/** A message of the thread history: with the stored `steps` of an assistant reply that has a finished-turn summary (issue #1887). */
export type SempThreadHistoryMessage = SempThreadMessage & { steps?: SempReplyStep[] };

/** The derived fields of a message read (issue #1890): `incompleteReason`, `mcpServerItemId` and `timeoutMs` only when incomplete. */
function replyOutcomeFields(
  reply: ReplyOutcome,
): Pick<SempThreadMessage, "outcome" | "incompleteReason" | "mcpServerItemId" | "timeoutMs"> {
  if (reply.outcome === "complete") return { outcome: "complete" };
  return {
    outcome: "incomplete",
    incompleteReason: reply.incompleteReason,
    ...(reply.mcpServerItemId !== undefined ? { mcpServerItemId: reply.mcpServerItemId } : {}),
    ...(reply.timeoutMs !== undefined ? { timeoutMs: reply.timeoutMs } : {}),
  };
}

/**
 * The `error` of each message of a page (issue #1907): `{ code, message }` for a failed message, with the text
 * rendered from the stored code and params in the locale of the tenant's user (Czech while it has none), and
 * `undefined` for any other message.
 */
async function renderedErrors(rows: readonly MessageRow[]): Promise<(SempThreadMessage["error"] | undefined)[]> {
  return Promise.all(
    rows.map(async (row) => {
      if (row.status !== "error") return undefined;
      const code = parseSempReplyErrorCode(row.error_code);
      const params = parseSempReplyErrorParams(row.error_params);
      return { code, message: await renderSempReplyFailure(code, params, row.user_locale ?? "cs") };
    }),
  );
}

export async function listSempThreadMessages(
  client: PoolClient,
  threadId: string,
  limit: number,
  before: { createdAt: string; id: string } | null,
) {
  const { rows } = await client.query<MessageRow>(
    `SELECT m.id, m.role, m.text, m.system_key, m.system_params, m.context, m.changes, m.reply_to_message_id, m.agent_run_id,
            m.event_from_id, m.status, m.steps, m.error_code, m.error_params, to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
            r.started_at AS run_started_at, r.finished_at AS run_finished_at, r.status AS run_status,
            (SELECT u.locale FROM users u WHERE u.tenant_id = (SELECT app_tenant_default())) AS user_locale
       FROM semp_messages m LEFT JOIN agent_runs r ON r.tenant_id = m.tenant_id AND r.id = m.agent_run_id
       WHERE m.thread_id = $1
         AND ($2::timestamptz IS NULL OR (m.created_at, m.id) < ($2::timestamptz, $3::uuid))
       ORDER BY m.created_at DESC, m.id DESC LIMIT $4`,
    [threadId, before?.createdAt ?? null, before?.id ?? null, limit + 1],
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const contexts = await resolveSempHistoryContexts(
    client,
    page.map((row) => row.context),
  );
  // The one reader of `semp_messages.steps` (issue #1887) parses each row once; the reply outcome (issue #1890) is derived from its result.
  const stepsOfRows = page.map((row) => parseStoredSempReplySteps(row.steps));
  const changes = await resolveSempHistoryChanges(
    client,
    page.map((row) => row.changes),
  );
  const errors = await renderedErrors(page);
  const last = page.at(-1);
  return {
    rows: page.map((row, index): SempThreadHistoryMessage => {
      const steps = stepsOfRows[index];
      return {
        id: row.id,
        role: assertKnownValue(["user", "assistant", "system"] as const, row.role, "message role"),
        text: row.text,
        system: row.system_key === null ? null : { key: row.system_key, params: row.system_params },
        context: contexts[index],
        replyToMessageId: row.reply_to_message_id,
        agentRunId: row.agent_run_id,
        eventFromId: row.event_from_id,
        status: row.status,
        ...(steps === undefined ? {} : { steps }),
        createdAt: row.created_at,
        ...(changes[index] === undefined ? {} : { changes: changes[index] }),
        ...replyOutcomeFields(deriveReplyOutcome(steps ?? [])),
        ...(errors[index] === undefined ? {} : { error: errors[index] }),
        run:
          row.run_started_at === null
            ? null
            : {
                startedAt: row.run_started_at.toISOString(),
                finishedAt: row.run_finished_at?.toISOString() ?? null,
                status: assertKnownValue(["running", "done", "error"] as const, row.run_status ?? "", "run status"),
              },
      };
    }),
    nextCursor:
      hasMore && last
        ? Buffer.from(JSON.stringify({ createdAt: last.created_at, id: last.id })).toString("base64url")
        : null,
  };
}
