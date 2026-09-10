import type { Pool, PoolClient } from "pg";
import { assertKnownValue } from "../dbRowValidation.js";
import { runAfterCommit } from "../db/pool.js";
import { notifyNotificationReadState } from "../realtimeHook.js";
import { NOTIFICATION_KINDS, type NotificationKind } from "./notificationKinds.js";

export interface NotificationRow {
  id: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  linkHref: string | null;
  sourceTable: string;
  sourceId: string;
  transitionInstance: string;
  createdAt: string;
  readAt: string | null;
}

interface NotificationDbRow {
  id: string;
  user_id: string;
  kind: string;
  title: string;
  link_href: string | null;
  source_table: string;
  source_id: string;
  transition_instance: string;
  created_at: Date;
  read_at: Date | null;
}

function mapRow(row: NotificationDbRow): NotificationRow {
  return {
    id: row.id,
    userId: row.user_id,
    kind: assertKnownValue(NOTIFICATION_KINDS, row.kind, "kind"),
    title: row.title,
    linkHref: row.link_href,
    sourceTable: row.source_table,
    sourceId: row.source_id,
    transitionInstance: row.transition_instance,
    createdAt: row.created_at.toISOString(),
    readAt: row.read_at ? row.read_at.toISOString() : null,
  };
}

const NOTIFICATION_COLUMNS =
  "id, user_id, kind, title, link_href, source_table, source_id, transition_instance, created_at, read_at";

/** Reload for the `notificationFanout` job (issue #151) — the writer's transaction has already committed by the time the job runs. */
export async function getNotificationById(client: Pool | PoolClient, id: string): Promise<NotificationRow | null> {
  const { rows } = await client.query<NotificationDbRow>(
    `SELECT ${NOTIFICATION_COLUMNS} FROM notifications WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * A reconnecting client's recovery path (issue #152): every unread notification for `userId`,
 * ordered deterministically by creation and then id so a client that paginates or dedupes against
 * a previously seen id gets a stable order even when two rows share a `created_at` timestamp.
 * Backed by `notifications_unread_idx` (migration 0030).
 */
export async function listUnreadNotificationsForUser(
  client: Pool | PoolClient,
  userId: string,
): Promise<NotificationRow[]> {
  const { rows } = await client.query<NotificationDbRow>(
    `SELECT ${NOTIFICATION_COLUMNS} FROM notifications
     WHERE user_id = $1 AND read_at IS NULL
     ORDER BY created_at, id`,
    [userId],
  );
  return rows.map(mapRow);
}

/**
 * Issue #152's visit-and-read operation: validates `notificationId` belongs to `userId` and, only
 * if it does, atomically marks it read (a no-op if it already was) and returns its current row —
 * the caller navigates to the returned row's `linkHref`. Returns `null` for both an unknown id and
 * one owned by a different user, deliberately indistinguishable so an authenticated caller can
 * never probe for another user's notification ids.
 *
 * The row-changed branch is what actually flips `read_at`; a repeat call on an already-read row
 * falls through to the plain, ownership-scoped re-fetch below and fires no realtime event — the
 * client already converged on that read the first time.
 */
export async function visitNotification(
  client: PoolClient,
  userId: string,
  notificationId: string,
): Promise<NotificationRow | null> {
  const { rows: changed } = await client.query<NotificationDbRow>(
    `UPDATE notifications SET read_at = now()
     WHERE id = $1 AND user_id = $2 AND read_at IS NULL
     RETURNING ${NOTIFICATION_COLUMNS}`,
    [notificationId, userId],
  );
  const changedRow = changed[0];
  if (changedRow) {
    const row = mapRow(changedRow);
    runAfterCommit(client, () => notifyNotificationReadState({ userId, notificationIds: [row.id] }));
    return row;
  }

  const { rows: existing } = await client.query<NotificationDbRow>(
    `SELECT ${NOTIFICATION_COLUMNS} FROM notifications WHERE id = $1 AND user_id = $2`,
    [notificationId, userId],
  );
  return existing[0] ? mapRow(existing[0]) : null;
}

/**
 * Issue #152's optional mark-all-read convenience: every currently unread notification for
 * `userId` in one statement, so cross-device badge convergence is a single realtime event instead
 * of one per row.
 */
export async function markAllNotificationsRead(client: PoolClient, userId: string): Promise<NotificationRow[]> {
  const { rows } = await client.query<NotificationDbRow>(
    `UPDATE notifications SET read_at = now()
     WHERE user_id = $1 AND read_at IS NULL
     RETURNING ${NOTIFICATION_COLUMNS}`,
    [userId],
  );
  const updated = rows.map(mapRow);
  if (updated.length > 0) {
    runAfterCommit(client, () =>
      notifyNotificationReadState({
        userId,
        notificationIds: updated.map((notification) => notification.id),
      }),
    );
  }
  return updated;
}
