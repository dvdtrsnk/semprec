import type { Pool, PoolClient } from "pg";
import { assertKnownValue } from "../dbRowValidation.js";
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

function mapRow(row: {
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
}): NotificationRow {
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

/** Reload for the `notificationFanout` job (issue #151) — the writer's transaction has already committed by the time the job runs. */
export async function getNotificationById(client: Pool | PoolClient, id: string): Promise<NotificationRow | null> {
  const { rows } = await client.query(
    `SELECT id, user_id, kind, title, link_href, source_table, source_id, transition_instance, created_at, read_at
     FROM notifications WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}
