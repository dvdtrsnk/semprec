// Issue gh-1936: what is specific to an `agentRun` Semp message ref that carries a `messageId`. The ref schema and the
// stored `context` are issues #1369 and #1682's. A ref with a `messageId` names one answer of a chat run: one
// assistant message of the thread the run holds. This module decides whether such a ref is valid and reads the answer
// the model is given for it; a ref without `messageId` keeps the whole-run validation and reading of the callers.
// Nothing here writes or logs.
import type { PoolClient } from "pg";
import type { AgentRunRow } from "../agentRuns/agentRunsStore.js";
import { parseStoredSempReplySteps } from "./sempStoredSteps.js";
import type { SempRefContext } from "./sempRefReadContext.js";

/** An `agentRun` ref that carries a `messageId`. */
export interface SempRunAnswerRef {
  agentRunId: string;
  messageId: string;
}

/** The characters of the question and of the result an answer's context holds; a longer text is cut and flagged. */
const ANSWER_TEXT_MAX_CHARS = 8000;
/** The steps of the answer's stored summary its context holds; a longer list is cut and flagged. */
const ANSWER_STEPS_MAX = 100;
/** The characters of the label: the question, or the run's task when the answer replies to no user message. */
const ANSWER_LABEL_MAX_CHARS = 120;

/**
 * Whether each of `refs` names an answer of its run, in the order given, read with one statement. An answer is an
 * assistant message of the thread of the run that was produced by that run (`agent_run_id`). A message that does not
 * exist, one of another tenant (row-level security shows only the caller's rows), a user or system message, a message
 * of another thread or of another run, and a run with no thread are all `false`, so the caller cannot tell them apart.
 * Whether the run itself exists follows from the same join: a missing run has no answer.
 */
export async function validateRunAnswerRefs(client: PoolClient, refs: readonly SempRunAnswerRef[]): Promise<boolean[]> {
  if (refs.length === 0) return [];
  const { rows } = await client.query<{ ordinal: number }>(
    `SELECT r.ordinal::int FROM unnest($1::uuid[], $2::uuid[]) WITH ORDINALITY AS r(run_id, message_id, ordinal)
     JOIN agent_runs run ON run.id = r.run_id
     JOIN semp_messages m ON m.id = r.message_id AND m.tenant_id = run.tenant_id AND m.role = 'assistant'
       AND m.thread_id = run.thread_id AND m.agent_run_id = run.id`,
    [refs.map((ref) => ref.agentRunId), refs.map((ref) => ref.messageId)],
  );
  const accepted = refs.map(() => false);
  for (const row of rows) {
    if (row.ordinal < 1 || row.ordinal > refs.length) throw new Error("Invalid reference ordinal");
    accepted[row.ordinal - 1] = true;
  }
  return accepted;
}

interface AnswerRow {
  status: string | null;
  result: string | null;
  result_truncated: boolean;
  steps: unknown;
  question: string | null;
  question_truncated: boolean;
  system_key: string | null;
}

/**
 * The context of one answer of `run`: the question it replies to (the text of the user message, or the `system_key`
 * of the system message), the result (the answer's text) and the steps summary stored on the assistant message, not
 * the rest of the run's conversation. `null` when the message is not an answer of the run any more, which is the
 * same test `validateRunAnswerRefs` applies, so the answer of a ref that was valid when it was sent can disappear.
 */
export async function readRunAnswerContext(
  client: PoolClient,
  run: AgentRunRow,
  messageId: string,
): Promise<SempRefContext | null> {
  if (run.threadId === null) return null;
  const { rows } = await client.query<AnswerRow>(
    `SELECT m.status, left(m.text, $4::int) AS result, COALESCE(length(m.text) > $4::int, false) AS result_truncated,
            m.steps, CASE WHEN replied.role = 'user' THEN left(replied.text, $4::int) END AS question,
            COALESCE(replied.role = 'user' AND length(replied.text) > $4::int, false) AS question_truncated,
            CASE WHEN replied.role = 'system' THEN replied.system_key END AS system_key
     FROM semp_messages m
     LEFT JOIN semp_messages replied ON replied.tenant_id = m.tenant_id AND replied.id = m.reply_to_message_id
     WHERE m.id = $1 AND m.role = 'assistant' AND m.thread_id = $2 AND m.agent_run_id = $3`,
    [messageId, run.threadId, run.id, ANSWER_TEXT_MAX_CHARS],
  );
  const row = rows[0];
  if (!row) return null;
  const steps = parseStoredSempReplySteps(row.steps) ?? [];
  return {
    label: Array.from(row.question ?? run.task)
      .slice(0, ANSWER_LABEL_MAX_CHARS)
      .join(""),
    state: "active",
    details: {
      question: row.question,
      systemKey: row.system_key,
      result: row.result,
      status: row.status,
      steps: steps.slice(0, ANSWER_STEPS_MAX),
      truncated: row.question_truncated || row.result_truncated || steps.length > ANSWER_STEPS_MAX,
    },
    blob: null,
  };
}
