import { toOperationError, type GenericOperations, type OperationError } from "../../api/genericOperations.js";

/**
 * The mailbox's triage actions, as generic operations. Marking a message read or flagged is
 * an item update of one user-owned checkbox property; archiving or deleting one is a pair of
 * relation writes on the Emails->Folders relation, moving it to the folder whose
 * `specialPurpose` says where it belongs. Nothing here is a mailbox-only backend call.
 *
 * Every action takes a list of message ids and reports per-message outcomes: one message
 * failing must not hide the ones that succeeded, which is what a bulk selection needs in
 * order to report a partial failure and keep exactly the unfinished messages selected.
 */
export interface TriageFailure {
  messageId: string;
  error: OperationError;
}

export interface TriageResult {
  succeeded: string[];
  failed: TriageFailure[];
}

async function perMessage(messageIds: readonly string[], run: (messageId: string) => Promise<void>): Promise<TriageResult> {
  const result: TriageResult = { succeeded: [], failed: [] };
  // Sequential on purpose: a bulk action is a handful of messages, and running them in order
  // keeps the reported failures in the order the user sees the rows in.
  for (const messageId of messageIds) {
    try {
      await run(messageId);
      result.succeeded.push(messageId);
    } catch (error) {
      result.failed.push({ messageId, error: toOperationError(error) });
    }
  }
  return result;
}

export interface SetFlagInput {
  databaseId: string;
  propertyKey: string;
  value: boolean;
}

/** Read state and flag state both go through here — they differ only in which property key they patch. */
export function setMessageFlag(operations: GenericOperations, input: SetFlagInput, messageIds: readonly string[]): Promise<TriageResult> {
  return perMessage(messageIds, async (messageId) => {
    await operations.updateItem(input.databaseId, messageId, { [input.propertyKey]: input.value });
  });
}

export interface MoveMessagesInput {
  databaseId: string;
  relationKey: string;
  fromFolderId: string;
  toFolderId: string;
}

/**
 * Archive and delete are the same move, differing only in the destination folder. The link
 * is written before the unlink: if the second call fails, the message is in both folders —
 * visibly recoverable — whereas the other order could leave it in no folder at all.
 */
export function moveMessages(operations: GenericOperations, input: MoveMessagesInput, messageIds: readonly string[]): Promise<TriageResult> {
  return perMessage(messageIds, async (messageId) => {
    await operations.linkItem(input.databaseId, messageId, input.relationKey, input.toFolderId);
    if (input.toFolderId !== input.fromFolderId) {
      await operations.unlinkItem(input.databaseId, messageId, input.relationKey, input.fromFolderId);
    }
  });
}

/**
 * Where the keyboard cursor lands once the given messages leave the list: the nearest
 * following message that stays, else the nearest preceding one, else nowhere. Predictable in
 * the way triage needs — archiving the message under the cursor leaves the cursor on the
 * next message, so the same key archives message after message without the user re-aiming.
 */
export function nextCursorAfterRemoval(orderedIds: readonly string[], cursorId: string | null, removedIds: readonly string[]): string | null {
  const removed = new Set(removedIds);
  if (!cursorId || !removed.has(cursorId)) return cursorId;
  const index = orderedIds.indexOf(cursorId);
  if (index === -1) return null;
  for (let i = index + 1; i < orderedIds.length; i += 1) {
    const candidate = orderedIds[i];
    if (candidate && !removed.has(candidate)) return candidate;
  }
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = orderedIds[i];
    if (candidate && !removed.has(candidate)) return candidate;
  }
  return null;
}

/** The cursor `j` (delta 1) and `k` (delta -1) move to; it stops at both ends rather than wrapping. */
export function movedCursor(orderedIds: readonly string[], cursorId: string | null, delta: number): string | null {
  if (orderedIds.length === 0) return null;
  const index = cursorId ? orderedIds.indexOf(cursorId) : -1;
  if (index === -1) return orderedIds[delta < 0 ? orderedIds.length - 1 : 0] ?? null;
  const next = Math.min(Math.max(index + delta, 0), orderedIds.length - 1);
  return orderedIds[next] ?? null;
}
