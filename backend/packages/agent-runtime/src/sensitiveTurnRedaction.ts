import { Pool, type PoolClient } from "pg";
import { createChokePoint, type ChokePoint } from "@alldots/data";
import { logger } from "./logger.js";
import {
  redactAssistantMessage,
  redactToolUse,
  storedAssistantMessage,
  toolCallTargetsOf,
} from "./sensitiveMessageRedaction.js";
import { carriesSensitiveMark, redactSensitiveToolResult } from "./sensitiveToolResult.js";
import type { AgentMessage } from "./types.js";

/** The operations whose call arguments carry the values to write. */
const CONTENT_BEARING_WRITES: ReadonlySet<unknown> = new Set(["item.create", "item.patch"]);

/** A stored `tool_use` carries it as its fields, an assistant `message` as a `ToolCallTarget`. */
interface CallIdentity {
  operation?: unknown;
  targetDatabaseId?: unknown;
  targetItemId?: unknown;
}

/**
 * Whether a call is an `item.create`/`item.patch` targeting a sensitive database (its `targetDatabaseId`, or the
 * database of its `targetItemId`, read through the choke point in the caller's tenant scope). No target, an
 * unresolvable target, a failed lookup or a run handle that is not a pool all count as sensitive, so arguments are
 * never stored in full on a doubt. A failed lookup is logged with operation, run and error class, never arguments.
 */
async function isSensitiveContentWrite(
  chokePoint: ChokePoint | null,
  message: CallIdentity,
  agentRunId: string,
): Promise<boolean> {
  if (!CONTENT_BEARING_WRITES.has(message.operation)) return false;
  if (chokePoint === null) return true;
  try {
    const databaseIds = new Set<string>();
    if (typeof message.targetDatabaseId === "string") databaseIds.add(message.targetDatabaseId);
    if (typeof message.targetItemId === "string") {
      const item = await chokePoint.findItemIncludingDeleted(message.targetItemId);
      if (item === null) return true;
      databaseIds.add(item.databaseId);
    }
    if (databaseIds.size === 0) return true;
    for (const databaseId of databaseIds) {
      const database = await chokePoint.getDatabase(databaseId);
      if (database === null || database.sensitive) return true;
    }
    return false;
  } catch (err) {
    logger.error(
      { operation: message.operation, agentRunId, errorName: err instanceof Error ? err.name : typeof err },
      "Could not read whether an agent tool call writes to a sensitive database; treating it as sensitive",
    );
    return true;
  }
}

/**
 * The `toolCall` block ids of an assistant `message` that are sensitive content writes, decided from the message's
 * `toolCallTargets` with the same lookup as the later `tool_use`.
 */
async function sensitiveWriteCallIds(
  chokePoint: ChokePoint | null,
  message: AgentMessage,
  agentRunId: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const target of toolCallTargetsOf(message)) {
    if (await isSensitiveContentWrite(chokePoint, target, agentRunId)) ids.add(target.toolCallId);
  }
  return ids;
}

/**
 * The persisted form of one `runAgentTurn` call's messages, in arrival order. After a stored `tool_result` carried the
 * sensitive mark, every later `tool_use` stores the marker as its arguments and every later assistant `message` is
 * redacted (`redactAssistantMessage`). A sensitive content write's `tool_use` is redacted from the start, as is its
 * `toolCall` block in the preceding assistant message (decided from `toolCallTargets`, which are never stored). Other
 * messages are returned as they are. Inputs are not modified: the running turn keeps the real messages.
 */
export interface SensitiveTurnRedactor {
  redact(message: AgentMessage): Promise<AgentMessage>;
}

export function createSensitiveTurnRedactor(client: Pool | PoolClient, agentRunId: string): SensitiveTurnRedactor {
  let sensitiveResultSeen = false;
  let chokePoint: ChokePoint | null | undefined;
  const chokePointOf = (): ChokePoint | null => {
    chokePoint ??= client instanceof Pool ? createChokePoint(client) : null;
    return chokePoint;
  };
  return {
    async redact(message) {
      if (message.kind === "tool_result") {
        if (carriesSensitiveMark(message)) sensitiveResultSeen = true;
        return redactSensitiveToolResult(message);
      }
      if (message.kind === "tool_use") {
        const sensitive =
          sensitiveResultSeen ||
          (await isSensitiveContentWrite(
            chokePointOf(),
            {
              operation: message.operation,
              targetDatabaseId: message.targetDatabaseId,
              targetItemId: message.targetItemId,
            },
            agentRunId,
          ));
        return sensitive ? redactToolUse(message) : message;
      }
      if (message.kind === "message") {
        if (sensitiveResultSeen) return redactAssistantMessage(message);
        return storedAssistantMessage(message, await sensitiveWriteCallIds(chokePointOf(), message, agentRunId));
      }
      return message;
    },
  };
}
