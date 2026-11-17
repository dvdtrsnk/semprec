import type { PoolClient } from "pg";
import { getTenantUserId } from "../auth/usersStore.js";
import { agentReplyProblemKey } from "./agentProblemKeys.js";
import { raiseProblem, resolveProblem, type RaiseProblemResult } from "./sempProblemsStore.js";

/** `null` when missing. A caller storing the final state in the same transaction holds the row lock. */
async function getRepliedToMessageId(client: PoolClient, assistantMessageId: string): Promise<string | null> {
  const { rows } = await client.query<{ reply_to_message_id: string | null }>(
    `SELECT reply_to_message_id FROM semp_messages
      WHERE tenant_id = app_tenant_default() AND id = $1 AND role = 'assistant'`,
    [assistantMessageId],
  );
  return rows[0]?.reply_to_message_id ?? null;
}

/**
 * Raises the `agents` problem of a failed or incomplete reply attempt in the caller's transaction. All attempts
 * of one reply share `agents:reply:<reply_to_message_id>`, each attempt is one occurrence, and the source follows
 * the latest failed attempt because only that one can be retried. Returns `null` when the message answers nothing
 * or the tenant has no bound user.
 */
export async function raiseAgentReplyProblem(
  client: PoolClient,
  assistantMessageId: string,
): Promise<RaiseProblemResult | null> {
  const repliedTo = await getRepliedToMessageId(client, assistantMessageId);
  if (repliedTo === null) return null;
  const userId = await getTenantUserId(client);
  if (userId === null) return null;
  return raiseProblem(client, {
    userId,
    category: "agents",
    kind: "reply",
    severity: "warning",
    sourceTable: "semp_messages",
    sourceId: assistantMessageId,
    dedupeKey: agentReplyProblemKey(repliedTo),
    occurrenceKey: assistantMessageId,
    followLatestSource: true,
  });
}

/** Resolves, as `recovered`, after a successful attempt. Returns whether a problem was active. */
export async function resolveAgentReplyProblem(client: PoolClient, assistantMessageId: string): Promise<boolean> {
  const repliedTo = await getRepliedToMessageId(client, assistantMessageId);
  if (repliedTo === null) return false;
  return resolveProblem(client, { dedupeKey: agentReplyProblemKey(repliedTo), resolutionKind: "recovered" });
}
