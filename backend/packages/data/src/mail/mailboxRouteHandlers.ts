import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { withTransaction } from "../db/pool.js";
import { NotFoundError } from "../errors.js";
import { defaultSyncModeForProvider, MAIL_SYNC_FAILURE_KINDS, SYNC_MODES } from "./mailAccountSyncStateStore.js";
import { imapConnectionLimitForProvider } from "./imapConnectionLimiter.js";
import { listAutonomousSendProjects } from "./mailAutonomousSendRouteHandlers.js";

const mailboxRow = z.object({
  id: z.uuid(),
  properties: z.record(z.string(), z.unknown()),
  sync_mode: z.enum(SYNC_MODES).nullable(),
  last_successful_sync_at: z.date().nullable(),
  failing_since: z.date().nullable(),
  initial_sync_completed_at: z.date().nullable(),
  last_failure_kind: z.enum(MAIL_SYNC_FAILURE_KINDS).nullable(),
});

async function readMailboxes(client: PoolClient, id: string | null) {
  const result = await client.query<Record<string, unknown>>(
    `SELECT i.id, i.properties, s.sync_mode, s.last_successful_sync_at, s.failing_since,
            s.initial_sync_completed_at, s.last_failure_kind
       FROM items i JOIN databases d ON d.id = i.database_id AND d.tenant_id = i.tenant_id
       LEFT JOIN mail_account_sync_state s ON s.item_id = i.id AND s.tenant_id = i.tenant_id
      WHERE i.tenant_id = app_tenant_default() AND d.system AND d.owner_module_id = 'mailboxes'
        AND i.deleted_at IS NULL AND ($1::uuid IS NULL OR i.id = $1)
      ORDER BY i.id`,
    [id],
  );
  // Issue #1635: the permission is per project, not per mailbox, so every mailbox shows the length of
  // the same list `GET /api/mail/autonomous-send-projects` returns.
  const autonomousSendProjectCount = (await listAutonomousSendProjects(client)).length;
  return result.rows.map((raw) => {
    const row = mailboxRow.parse(raw);
    const p = row.properties;
    const provider = typeof p.provider === "string" ? p.provider : null;
    const addresses =
      typeof p.addresses === "string"
        ? p.addresses
            .split(/[\n,\r]+/)
            .map((v) => v.trim())
            .filter(Boolean)
        : [];
    const syncMode = row.sync_mode ?? defaultSyncModeForProvider(provider ?? "");
    const storedStatus = z.enum(["ok", "error", "never", "needsReauthorization"]).nullish().parse(p.syncStatus);
    const syncStatus = storedStatus ?? (row.initial_sync_completed_at === null ? "never" : null);
    const defaultLimit = imapConnectionLimitForProvider(provider ?? undefined);
    return {
      id: row.id,
      name: typeof p.name === "string" ? p.name : "",
      provider,
      primaryAddress: addresses[0] ?? null,
      addresses,
      syncMode,
      syncStatus,
      initialSyncInProgress: row.initial_sync_completed_at === null,
      lastSuccessfulSyncAt: row.last_successful_sync_at?.toISOString() ?? null,
      failingSince: row.failing_since?.toISOString() ?? null,
      reason: syncStatus === "error" || syncStatus === "needsReauthorization" ? row.last_failure_kind : null,
      connectionLimit: {
        value: imapConnectionLimitForProvider(provider ?? undefined, p.connectionLimit),
        default: defaultLimit,
        applies: syncMode === "imap",
      },
      autonomousSendProjectCount,
    };
  });
}

export function createMailboxListRouteHandler(pool: Pool) {
  return async () => ({
    status: 200,
    body: { mailboxes: await withTransaction(pool, (client) => readMailboxes(client, null)) },
  });
}

export function createMailboxDetailRouteHandler(pool: Pool) {
  return async (ctx: { params: Record<string, string> }) => {
    const id = z.uuid().safeParse(ctx.params.id);
    const rows = id.success ? await withTransaction(pool, (client) => readMailboxes(client, id.data)) : [];
    if (!rows[0]) throw new NotFoundError("Mailbox not found");
    return { status: 200, body: rows[0] };
  };
}
