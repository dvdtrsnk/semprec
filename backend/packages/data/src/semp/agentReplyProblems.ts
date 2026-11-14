import type { PoolClient } from "pg";
import { getTenantUserId } from "../auth/usersStore.js";
import { agentReplyProblemKey } from "./agentProblemKeys.js";
import { raiseProblem, resolveProblem, type RaiseProblemResult } from "./sempProblemsStore.js";

/**
 * The message an assistant message answers (`semp_messages.reply_to_message_id`), read in the caller's open
 * transaction, or `null` when the message is missing or answers nothing. A caller that stores the final state of
 * the message in the same transaction has the row locked, so the reference cannot change under it.
 */
async function getRepliedToMessageId(client: PoolClient, assistantMessageId: string): Promise<string | null> {
  const { rows } = await client.query<{ reply_to_message_id: string | null }>(
    `SELECT reply_to_message_id FROM semp_messages
      WHERE tenant_id = app_tenant_default() AND id = $1 AND role = 'assistant'`,
    [assistantMessageId],
  );
  return rows[0]?.reply_to_message_id ?? null;
}

/**
 * Raises the `agents` problem of a Semp reply whose attempt `assistantMessageId` failed or came out incomplete
 * (issue #1931), in the caller's open transaction, so it commits or rolls back with the message result. All
 * attempts of one reply share the key `agents:reply:<reply_to_message_id>`; each failed attempt is one occurrence
 * (the message id is the occurrence key), and the problem's source follows the latest failed attempt's message:
 * only the latest attempt of a reply can be retried, so the retry and open-chat actions built from the source
 * must target it. The problem holds no user content: the thread is reached through the source message.
 *
 * Returns `null`, and raises nothing, when the message answers no message or the tenant has no bound user to
 * show the problem to.
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

/**
 * Resolves the `agents` problem of the reply that the successful, complete attempt `assistantMessageId` answers
 * (issue #1931), as `recovered`, in the caller's open transaction. Returns whether a problem was active; a
 * message that answers no message resolves nothing.
 */
export async function resolveAgentReplyProblem(client: PoolClient, assistantMessageId: string): Promise<boolean> {
  const repliedTo = await getRepliedToMessageId(client, assistantMessageId);
  if (repliedTo === null) return false;
  return resolveProblem(client, { dedupeKey: agentReplyProblemKey(repliedTo), resolutionKind: "recovered" });
}
