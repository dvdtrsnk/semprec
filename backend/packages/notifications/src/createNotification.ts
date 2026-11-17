import type { PoolClient } from "pg";
import { writeNotification, type WriteNotificationInput } from "@semprec/data";

export type CreateNotificationInput = WriteNotificationInput;

/**
 * Thin adapter over `@semprec/data`'s `writeNotification`, the single notification writer (insert,
 * fanout-job enqueue and realtime push in the caller's transaction `tx`). Returns the notification id
 * both for a fresh insert and a replayed duplicate, since callers may key downstream writes off it.
 */
export function createNotification(tx: PoolClient, input: CreateNotificationInput): Promise<string> {
  return writeNotification(tx, input);
}
