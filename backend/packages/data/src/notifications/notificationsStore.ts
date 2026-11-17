import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { assertKnownValue } from "../dbRowValidation.js";
import { runAfterCommit } from "../db/pool.js";
import { enqueuePushDismiss } from "../push/pushDismissJob.js";
import { notifyNotificationReadState } from "../realtimeHook.js";
import { NOTIFICATION_KINDS, policyForKind, type NotificationKind } from "./notificationKinds.js";

export interface NotificationRow {
  id: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  /** Rendered in the recipient's locale at write time; `null` for a kind that has none. */
  body: string | null;
  linkHref: string | null;
  sourceTable: string;
  sourceId: string;
  transitionInstance: string;
  payload: Record<string, unknown>;
  createdAt: string;
  readAt: string | null;
  resolvedAt: string | null;
}

interface NotificationDbRow {
  id: string;
  user_id: string;
  kind: string;
  title: string;
  body: string | null;
  link_href: string | null;
  source_table: string;
  source_id: string;
  transition_instance: string;
  payload: unknown;
  created_at: Date;
  read_at: Date | null;
  resolved_at: Date | null;
}

function mapRow(row: NotificationDbRow): NotificationRow {
  if (row.payload === null || typeof row.payload !== "object" || Array.isArray(row.payload)) {
    throw new Error("Invalid notification payload");
  }
  let payload: Record<string, unknown> = Object.fromEntries(Object.entries(row.payload));
  if (row.kind === "mail_sync_stalled") {
    const mailbox = z.uuid().safeParse(payload.mailboxItemId);
    if (!mailbox.success) throw new Error("Invalid mail sync notification mailbox id");
    const reason = payload.reason;
    payload = {
      mailboxItemId: mailbox.data,
      reason: reason === "reauthorization" || reason === "connectionLimit" || reason === "other" ? reason : "other",
    };
  }
  return {
    id: row.id,
    userId: row.user_id,
    kind: assertKnownValue(NOTIFICATION_KINDS, row.kind, "kind"),
    title: row.title,
    body: row.body,
    linkHref: row.link_href,
    sourceTable: row.source_table,
    sourceId: row.source_id,
    transitionInstance: row.transition_instance,
    payload,
    createdAt: row.created_at.toISOString(),
    readAt: row.read_at ? row.read_at.toISOString() : null,
    resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
  };
}

const NOTIFICATION_COLUMNS =
  "id, user_id, kind, title, body, link_href, source_table, source_id, transition_instance, payload, created_at, read_at, resolved_at";

/**
 * Bounds one recovery fetch or mark-all-read sweep so an unbounded backlog cannot force a huge
 * query; a user past the cap converges over further rounds.
 */
const MAX_UNREAD_NOTIFICATIONS_PER_QUERY = 500;

export async function listResolvedNotificationIds(
  client: PoolClient,
  userId: string,
  since: string,
  limit: number,
  afterId?: string,
): Promise<Array<{ id: string; resolvedAt: string }>> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid resolved notification limit");
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT id, to_char(resolved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS resolved_at
     FROM notifications
     WHERE tenant_id = app_tenant_default() AND user_id = $1 AND resolved_at IS NOT NULL
       AND (($3::uuid IS NULL AND resolved_at > $2::timestamptz)
         OR ($3::uuid IS NOT NULL AND (resolved_at, id) > ($2::timestamptz, $3::uuid)))
     ORDER BY resolved_at ASC, id ASC LIMIT $4`,
    [userId, since, afterId ?? null, Math.min(limit, 500)],
  );
  return rows.map((row) => {
    const parsed = z.object({ id: z.uuid(), resolved_at: z.string() }).parse(row);
    return { id: parsed.id, resolvedAt: parsed.resolved_at };
  });
}

export async function getNotificationById(client: Pool | PoolClient, id: string): Promise<NotificationRow | null> {
  const { rows } = await client.query<NotificationDbRow>(
    `SELECT ${NOTIFICATION_COLUMNS} FROM notifications WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Reconnect recovery. Ordered by creation then id so ties are stable. Uses `notifications_unread_idx`. */
export async function listUnreadNotificationsForUser(
  client: Pool | PoolClient,
  userId: string,
): Promise<NotificationRow[]> {
  const { rows } = await client.query<NotificationDbRow>(
    `SELECT ${NOTIFICATION_COLUMNS} FROM notifications
     WHERE user_id = $1 AND read_at IS NULL
     ORDER BY created_at, id
     LIMIT ${MAX_UNREAD_NOTIFICATIONS_PER_QUERY}`,
    [userId],
  );
  return rows.map(mapRow);
}

/**
 * `null` for unknown and foreign ids alike, so other users' ids cannot be probed. Only a call that
 * actually flips `read_at` fires a realtime event.
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

/** One statement, so cross-device convergence is one realtime event rather than one per row. */
export async function markAllNotificationsRead(client: PoolClient, userId: string): Promise<NotificationRow[]> {
  const { rows } = await client.query<NotificationDbRow>(
    `UPDATE notifications SET read_at = now()
     WHERE ctid IN (
       SELECT ctid FROM notifications
       WHERE user_id = $1 AND read_at IS NULL
       ORDER BY created_at, id
       LIMIT ${MAX_UNREAD_NOTIFICATIONS_PER_QUERY}
     )
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

/**
 * Resolves (and reads) a source's notifications in the caller's transaction, so it commits with
 * the decision that handled the source; a replay changes and publishes nothing. Read-state events
 * fire after commit only for rows this call newly read. For pushed kinds it also enqueues one
 * `pushDismiss` per user so devices remove the visible push.
 */
export async function resolveNotificationsBySource(
  client: PoolClient,
  input: { sourceTable: string; sourceId: string },
): Promise<NotificationRow[]> {
  const { rows } = await client.query<NotificationDbRow & { newly_read: boolean }>(
    `WITH previous AS (
       SELECT id, read_at FROM notifications
       WHERE source_table = $1 AND source_id = $2 AND resolved_at IS NULL
       FOR UPDATE
     )
     UPDATE notifications n
     SET resolved_at = now(), read_at = COALESCE(n.read_at, now())
     FROM previous
     WHERE n.id = previous.id
     RETURNING ${NOTIFICATION_COLUMNS.split(", ")
       .map((column) => `n.${column}`)
       .join(", ")}, (previous.read_at IS NULL) AS newly_read`,
    [input.sourceTable, input.sourceId],
  );

  const dismissIdsByUser = new Map<string, string[]>();
  for (const row of rows) {
    if (!policyForKind(assertKnownValue(NOTIFICATION_KINDS, row.kind, "kind")).push) continue;
    const ids = dismissIdsByUser.get(row.user_id) ?? [];
    ids.push(row.id);
    dismissIdsByUser.set(row.user_id, ids);
  }
  for (const [userId, notificationIds] of dismissIdsByUser) {
    await enqueuePushDismiss(client, { userId, notificationIds });
  }

  const idsByUser = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.newly_read) continue;
    const ids = idsByUser.get(row.user_id) ?? [];
    ids.push(row.id);
    idsByUser.set(row.user_id, ids);
  }
  if (idsByUser.size > 0) {
    runAfterCommit(client, () => {
      for (const [userId, notificationIds] of idsByUser) {
        notifyNotificationReadState({ userId, notificationIds });
      }
    });
  }
  return rows.map(mapRow);
}
