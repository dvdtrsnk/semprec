import { Pool, type PoolClient } from "pg";
import { createChokePoint, type ChokePoint } from "@semprec/data";
import { logger } from "./logger.js";
import {
  redactAssistantMessage,
  redactToolUse,
  storedAssistantMessage,
  toolCallTargetsOf,
} from "./sensitiveMessageRedaction.js";
import { carriesSensitiveMark, redactSensitiveToolResult } from "./sensitiveToolResult.js";
import type { AgentMessage } from "./types.js";

/** The operations whose call arguments carry the values to write (issue #2001). */
const CONTENT_BEARING_WRITES: ReadonlySet<unknown> = new Set(["item.create", "item.patch"]);

/** The identity of one call: a stored `tool_use` carries it as its fields, an assistant `message` as a `ToolCallTarget`. */
interface CallIdentity {
  operation?: unknown;
  targetDatabaseId?: unknown;
  targetItemId?: unknown;
}

/**
 * Whether a call is a content-bearing write (`item.create`, `item.patch`) whose target is a sensitive
 * database. The target databases are the call's `targetDatabaseId` and the database of its `targetItemId`, read
 * through the choke point in the caller's tenant scope. A call that names no target, an item or database that
 * resolves to nothing, a lookup that fails and a run handle that is not a pool (so no choke point can be built)
 * all count as sensitive, so the arguments are not stored in full on a doubt. A failed lookup is logged with the
 * operation, the run and the error class, never with the arguments.
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
 * The ids of the `toolCall` blocks of an assistant `message` that are content-bearing writes to a sensitive database,
 * decided from the operation and targets the session attached to the message (`toolCallTargets`), each by the same
 * `isSensitiveContentWrite` lookup as the `tool_use` stored later. A message without targets yields none.
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
 * The persisted form of the messages of one `runAgentTurn` call (issue #2001, which extends the stored
 * `tool_result` redaction of issue #1827), kept in arrival order. Once a persisted `tool_result` has carried the
 * sensitive mark, every later `tool_use` of the call is stored with the marker as its arguments and every later
 * assistant `message` is stored redacted (`redactAssistantMessage`); a `tool_use` of a content-bearing write to a
 * sensitive database is stored with the marker as its arguments from its own `isSensitiveContentWrite` lookup, marked
 * result or not, and so is the `toolCall` block of such a call in the assistant `message` that precedes it, decided
 * from the `toolCallTargets` the session attached to that message (the message never stores them). Any other message
 * is returned as it is. The messages handed in are not modified: the running turn
 * keeps the real ones.
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
