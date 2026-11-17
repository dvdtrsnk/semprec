import type { PoolClient } from "pg";
import { assertKnownValue } from "../dbRowValidation.js";
import { requireAffectedRows, requireSingleRow, type Queryable } from "../db/pool.js";
import { publishNotificationPreferencesInvalidation } from "./notificationInvalidation.js";

export const NOTIFICATION_PROBLEMS_LEVELS = ["off", "critical", "all"] as const;
export type NotificationProblemsLevel = (typeof NOTIFICATION_PROBLEMS_LEVELS)[number];

/** `updatedAt` is null while the user has no row. */
export interface NotificationPreferences {
  approvals: boolean;
  invites: boolean;
  reminders: boolean;
  problemsLevel: NotificationProblemsLevel;
  problemsSummary: boolean;
  badgeApprovals: boolean;
  badgeInvites: boolean;
  badgeInbox: boolean;
  updatedAt: string | null;
}

export type NotificationPreferencesPatch = Partial<Omit<NotificationPreferences, "updatedAt">>;

/** Must match the column defaults. */
const DEFAULT_VALUES: Omit<NotificationPreferences, "updatedAt"> = {
  approvals: true,
  invites: true,
  reminders: true,
  problemsLevel: "critical",
  problemsSummary: true,
  badgeApprovals: true,
  badgeInvites: true,
  badgeInbox: false,
};

interface NotificationPreferencesDbRow {
  approvals: boolean;
  invites: boolean;
  reminders: boolean;
  problems_level: string;
  problems_summary: boolean;
  badge_approvals: boolean;
  badge_invites: boolean;
  badge_inbox: boolean;
  updated_at: Date;
}

const PREFERENCE_COLUMNS = `approvals, invites, reminders, problems_level, problems_summary,
  badge_approvals, badge_invites, badge_inbox, updated_at`;

function mapRow(row: NotificationPreferencesDbRow): NotificationPreferences {
  return {
    approvals: row.approvals,
    invites: row.invites,
    reminders: row.reminders,
    problemsLevel: assertKnownValue(NOTIFICATION_PROBLEMS_LEVELS, row.problems_level, "problems_level"),
    problemsSummary: row.problems_summary,
    badgeApprovals: row.badge_approvals,
    badgeInvites: row.badge_invites,
    badgeInbox: row.badge_inbox,
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Never writes a row. */
export async function getNotificationPreferences(client: Queryable, userId: string): Promise<NotificationPreferences> {
  const { rows } = await client.query<NotificationPreferencesDbRow>(
    `SELECT ${PREFERENCE_COLUMNS} FROM notification_preferences WHERE user_id = $1`,
    [userId],
  );
  const row = rows[0];
  return row ? mapRow(row) : { ...DEFAULT_VALUES, updatedAt: null };
}

/**
 * Insert-then-update in the caller's transaction; `COALESCE` keeps fields the patch omits. An
 * empty patch writes and announces nothing.
 */
export async function patchNotificationPreferences(
  client: PoolClient,
  userId: string,
  patch: NotificationPreferencesPatch,
): Promise<NotificationPreferences> {
  const hasChange = Object.values(patch).some((value) => value !== undefined);
  if (!hasChange) return getNotificationPreferences(client, userId);

  await client.query(
    "INSERT INTO notification_preferences (user_id) VALUES ($1) ON CONFLICT (tenant_id, user_id) DO NOTHING",
    [userId],
  );
  const result = await client.query<NotificationPreferencesDbRow>(
    `UPDATE notification_preferences SET
       approvals = COALESCE($2::boolean, approvals),
       invites = COALESCE($3::boolean, invites),
       reminders = COALESCE($4::boolean, reminders),
       problems_level = COALESCE($5::text, problems_level),
       problems_summary = COALESCE($6::boolean, problems_summary),
       badge_approvals = COALESCE($7::boolean, badge_approvals),
       badge_invites = COALESCE($8::boolean, badge_invites),
       badge_inbox = COALESCE($9::boolean, badge_inbox),
       updated_at = now()
     WHERE user_id = $1
     RETURNING ${PREFERENCE_COLUMNS}`,
    [
      userId,
      patch.approvals ?? null,
      patch.invites ?? null,
      patch.reminders ?? null,
      patch.problemsLevel ?? null,
      patch.problemsSummary ?? null,
      patch.badgeApprovals ?? null,
      patch.badgeInvites ?? null,
      patch.badgeInbox ?? null,
    ],
  );
  requireAffectedRows(result, "notification preferences update");
  publishNotificationPreferencesInvalidation(client, userId);
  return mapRow(requireSingleRow(result.rows, "notification preferences update"));
}
