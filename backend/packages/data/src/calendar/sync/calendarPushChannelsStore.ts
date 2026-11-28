// `calendar_push_channels`: the Google Calendar channels and Microsoft Graph subscriptions that tell the calendar
// sync about provider changes. This module is the table's only writer.
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { runAsSystem } from "@alldots/shared";
import type { Queryable } from "../../db/pool.js";
import { MAILBOXES_MODULE_ID } from "../../seed/emailModuleKeys.js";

export const CALENDAR_PUSH_PROVIDERS = ["google", "graph"] as const;
export type CalendarPushProvider = (typeof CALENDAR_PUSH_PROVIDERS)[number];

const channelRow = z.object({
  provider: z.enum(CALENDAR_PUSH_PROVIDERS),
  channel_id: z.string(),
  account_item_id: z.uuid(),
  calendar_item_id: z.uuid().nullable(),
  resource_id: z.string().nullable(),
  secret: z.string(),
  expires_at: z.date(),
});

export interface CalendarPushChannel {
  provider: CalendarPushProvider;
  /** Google: the id this server chose; Graph: the subscription id. */
  channelId: string;
  accountItemId: string;
  /** Google only: the watched calendar. */
  calendarItemId: string | null;
  /** Google only: what `channels.stop` takes besides the id. */
  resourceId: string | null;
  /** The channel token (Google) or `clientState` (Graph). */
  secret: string;
  expiresAt: Date;
}

const CHANNEL_COLUMNS = "provider, channel_id, account_item_id, calendar_item_id, resource_id, secret, expires_at";

function mapChannel(raw: unknown): CalendarPushChannel {
  const row = channelRow.parse(raw);
  return {
    provider: row.provider,
    channelId: row.channel_id,
    accountItemId: row.account_item_id,
    calendarItemId: row.calendar_item_id,
    resourceId: row.resource_id,
    secret: row.secret,
    expiresAt: row.expires_at,
  };
}

export async function insertCalendarPushChannel(client: Queryable, channel: CalendarPushChannel): Promise<void> {
  await client.query(`INSERT INTO calendar_push_channels (${CHANNEL_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
    channel.provider,
    channel.channelId,
    channel.accountItemId,
    channel.calendarItemId,
    channel.resourceId,
    channel.secret,
    channel.expiresAt,
  ]);
}

export async function getCalendarPushChannel(
  client: Queryable,
  provider: CalendarPushProvider,
  channelId: string,
): Promise<CalendarPushChannel | null> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT ${CHANNEL_COLUMNS} FROM calendar_push_channels WHERE provider = $1 AND channel_id = $2`,
    [provider, channelId],
  );
  return rows[0] === undefined ? null : mapChannel(rows[0]);
}

export async function listCalendarPushChannelsOfAccount(
  client: Queryable,
  accountItemId: string,
): Promise<CalendarPushChannel[]> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT ${CHANNEL_COLUMNS} FROM calendar_push_channels WHERE account_item_id = $1
      ORDER BY provider, expires_at, channel_id`,
    [accountItemId],
  );
  return rows.map(mapChannel);
}

/** Zero rows when another run or the account's removal deleted it first. */
export async function deleteCalendarPushChannel(
  client: Queryable,
  provider: CalendarPushProvider,
  channelId: string,
): Promise<number> {
  const result = await client.query("DELETE FROM calendar_push_channels WHERE provider = $1 AND channel_id = $2", [
    provider,
    channelId,
  ]);
  return result.rowCount ?? 0;
}

/** Deletes every channel of the account and returns them, for the provider calls after the removal commits. */
export async function takeCalendarPushChannelsOfAccount(
  client: PoolClient,
  accountItemId: string,
): Promise<CalendarPushChannel[]> {
  const { rows } = await client.query<Record<string, unknown>>(
    `DELETE FROM calendar_push_channels WHERE account_item_id = $1 RETURNING ${CHANNEL_COLUMNS}`,
    [accountItemId],
  );
  return rows.map(mapChannel);
}

/** `false` when the row is gone (stopped or removed meanwhile). */
export async function recordCalendarPushChannelExpiry(
  client: Queryable,
  provider: CalendarPushProvider,
  channelId: string,
  expiresAt: Date,
): Promise<boolean> {
  const result = await client.query(
    "UPDATE calendar_push_channels SET expires_at = $3 WHERE provider = $1 AND channel_id = $2",
    [provider, channelId, expiresAt],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Accounts the maintenance looks at: every account that has a channel, and every live account with Calendars on
 * whose sync mode is one of `syncModes`.
 */
export async function listCalendarPushAccounts(client: Queryable, syncModes: readonly string[]): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT DISTINCT account_item_id AS id FROM calendar_push_channels
     UNION
     SELECT i.id
       FROM items i
       JOIN databases d ON d.id = i.database_id AND d.tenant_id = i.tenant_id
       JOIN mail_account_sync_state m ON m.tenant_id = i.tenant_id AND m.item_id = i.id
      WHERE d.system AND d.owner_module_id = $1 AND i.deleted_at IS NULL
        AND i.properties->'calendarsEnabled' = 'true'::jsonb AND m.sync_mode = ANY($2::text[])
     ORDER BY id`,
    [MAILBOXES_MODULE_ID, syncModes],
  );
  return rows.map((row) => row.id);
}

const ROUTER_QUERIES: Readonly<Record<CalendarPushProvider, string>> = {
  google: "SELECT tenant_id FROM route_google_calendar_channel($1)",
  graph: "SELECT tenant_id FROM route_graph_calendar_subscription($1)",
};

/**
 * The tenant of a channel named by a public webhook, before any tenant is known, through the router function of the
 * provider. `null` when no tenant, or more than one, has the id: a duplicate names neither.
 */
export async function routeCalendarPushChannel(
  pool: Pool,
  provider: CalendarPushProvider,
  channelId: string,
): Promise<string | null> {
  const tenantIds = await runAsSystem("calendar-webhook", async () => {
    const { rows } = await pool.query<{ tenant_id: string }>(ROUTER_QUERIES[provider], [channelId]);
    return rows.map((row) => row.tenant_id);
  });
  const [tenantId] = tenantIds;
  return tenantId === undefined || tenantIds.length > 1 ? null : tenantId;
}
