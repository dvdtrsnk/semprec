import type { PoolClient } from "pg";
import { writeNotification, type WriteNotificationInput } from "@semprec/data";

export type CreateNotificationInput = WriteNotificationInput;

/**
 * Issue #85's literal `packages/notifications/src/createNotification.ts` adapter: `tx` is the
 * caller's own open transaction, `input` is the same shape `writeNotification` (`@semprec/data`,
 * issue #36/#152) already accepts, and the returned value is the notification's id — present in
 * both the fresh-insert and the replayed-duplicate case, since a caller keying a downstream write
 * off the id (e.g. as a notification's own source id) needs one regardless of which happened.
 *
 * This is a thin re-export, not a second implementation: `@semprec/data`'s `writeNotification` is
 * this codebase's single notification writer (the same one `agent_run_error`, `heartbeat_error`,
 * and the library/mail sync jobs already use) — insert + fanout-job enqueue + realtime push all
 * happen there, in the caller's own transaction, exactly once. `createNotification` exists at this
 * path only so a consumer that names it that way (as `GuidanceNotificationWriter`'s adapter,
 * `guidanceNotificationWriter.ts`, does) has a stable import target without duplicating the write
 * path itself — the [[2026-09-10-choke-point-api-for-state-writes]] "one write path" principle
 * applies to notifications the same way it does to item/database state.
 */
export function createNotification(tx: PoolClient, input: CreateNotificationInput): Promise<string> {
  return writeNotification(tx, input);
}
