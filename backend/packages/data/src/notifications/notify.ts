import type { PoolClient } from "pg";
import { loadModuleCatalogs, resolveCatalogLabel, type ModuleCatalogs } from "@semprec/module-registry";
import { getUserById } from "../auth/usersStore.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import { markManagedTransactionRollbackOnly, requireManagedTransaction, runAfterCommit } from "../db/pool.js";
import { notifyNotificationCreated } from "../realtimeHook.js";
import { enqueueNotificationFanout } from "./notificationFanoutJob.js";
import type { NotificationKind } from "./notificationKinds.js";
import { getItemsByIds } from "../chokePoint/itemsStore.js";

let catalogsPromise: Promise<ModuleCatalogs> | undefined;

/** Lazily loaded once per process and reused — `notifications/i18n/{cs,en}.json` never changes at runtime. */
function getNotificationCatalogs(): Promise<ModuleCatalogs> {
  catalogsPromise ??= loadModuleCatalogs(import.meta.url);
  return catalogsPromise;
}

/** Catalog key rendered for a `null` body parameter, such as the name of an item that has none (issue #1773). */
const UNNAMED_LABEL_KEY = "notification.body.unnamed";

/** Replaces each `{param}` placeholder in `template` with `params[param]`, leaving an unmatched placeholder untouched. */
function interpolate(template: string, params: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, key: string) => params[key] ?? placeholder);
}

/** Renders a body template: numbers as text, and every `null` as the localised unnamed label. */
function renderBody(
  template: string,
  params: Readonly<Record<string, string | number | null>>,
  unnamedLabel: string,
  optionalProjectName: boolean,
): string {
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(params)) {
    values[name] = value === null ? unnamedLabel : String(value);
  }
  if (optionalProjectName) values.projectName ??= "";
  const rendered = interpolate(template, values);
  return optionalProjectName ? rendered.trimEnd() : rendered;
}

export interface WriteNotificationInput {
  /** Who this notification is for. Resolved by the producer — the writer never guesses a recipient. */
  userId: string;
  kind: NotificationKind;
  /** Substituted into the `notification.<kind>.title` catalog entry (e.g. `{name}` for `heartbeat_error`). */
  titleParams?: Readonly<Record<string, string>>;
  /**
   * Catalog key of this notification's body (issue #1773), rendered in the recipient's locale the
   * same way as the title and stored in `notifications.body`. Absent: the stored body is NULL.
   */
  bodyKey?: string;
  /**
   * Substituted into the body entry's `{param}` placeholders. A `null` value renders as the
   * `notification.body.unnamed` label; a param the entry does not name is ignored.
   */
  bodyParams?: Readonly<Record<string, string | number | null>>;
  bodySuffixKey?: string;
  /**
   * Where this notification's title should link, already resolved to the app's URL scheme
   * (e.g. `?page=agent-run&id=...`) — the writer has no per-kind routing knowledge, only the
   * producer does. `null` when the source has no dedicated destination yet.
   */
  linkHref: string | null;
  /** The durable row this notification is about, e.g. `'project_heartbeats'`. */
  sourceTable: string;
  sourceId: string;
  /**
   * Identifies *this* state transition of `(sourceTable, sourceId, kind)` for *this recipient* —
   * replaying the same transition for the same recipient (a redelivered/retried queue job
   * re-running the same failure) must not duplicate the notification, while a later, independent
   * transition on the same source must still insert a new row. `scheduler/sweep.ts`'s
   * `heartbeat_error` producer uses the firing queue job's own `id`, which is stable across that
   * job's retries and distinct for every new fire.
   */
  transitionInstance: string;
  /**
   * Structured data a client can render without a second round trip to the source row (issue
   * #85's drift findings are the first producer). Defaults to `{}` (migration 0035's column
   * default) when omitted.
   */
  payload?: Record<string, unknown>;
}

/**
 * Runs on the caller's transaction client (never opens its own transaction): rolling back the
 * caller's transaction rolls this insert back with it, and committing it exposes both together.
 * Deduplicates per tenant and recipient on `(tenant_id, userId, sourceTable, sourceId, kind,
 * transitionInstance)` via `notifications_tenant_dedupe_idx` (migration 0064) — a replay is a
 * silent no-op, never a second row, and returns that recipient's own notification id. Two
 * recipients of the same source transition each get their own row.
 *
 * On an actual (non-replay) insert, also enqueues issue #151's `notificationFanout` job in the
 * same transaction — "this notification exists" and "delivery will be attempted" land together,
 * the same commit-coupling pattern as `decideAndEnqueueApprovalRequest`. A replay enqueues
 * nothing new: the row already has a notification, and that notification's fanout job (keyed by
 * its own id) either already ran or is already queued.
 *
 * Fires issue #152's `notifyNotificationCreated` realtime hook via `runAfterCommit`. Resolved
 * guidance notifications register it only for a managed transaction; an unmanaged caller has
 * no transaction-completion owner. SQL notification and fanout remain in the caller transaction.
 *
 * Returns the notification's id in both the fresh-insert and the replayed-duplicate case (issue
 * #85's `packages/notifications` adapter needs a stable id to hand back regardless of which
 * happened) — the `ON CONFLICT ... DO UPDATE` no-op plus `xmax = 0` is the standard Postgres
 * "upsert always returns a row, and tells you whether it inserted" idiom.
 */
export async function writeNotification(client: PoolClient, input: WriteNotificationInput): Promise<string> {
  if (input.bodyKey === undefined && input.bodySuffixKey !== undefined)
    throw new Error("Notification suffix requires a body");
  const user = await getUserById(client, input.userId);
  if (!user) {
    throw new Error(`writeNotification: no user with id "${input.userId}"`);
  }

  const catalogs = await getNotificationCatalogs();
  const locale = toManifestLocale(user.locale);
  const localeCatalog = catalogs[locale];
  let payload = input.payload ?? {};
  const resolvedKind = input.kind === "agent_guidance_drift_resolved";
  const driftKind = Object.hasOwn(payload, "kind") ? payload.kind : "permission";
  if (resolvedKind && driftKind !== "permission" && driftKind !== "behavior")
    throw new Error("Invalid guidance drift kind");
  if (resolvedKind && typeof payload.projectItemId !== "string") throw new Error("Missing guidance drift project");
  const titleTemplate = resolveCatalogLabel(null, localeCatalog, catalogs.en, `notification.${input.kind}.title`);
  const title = interpolate(titleTemplate, input.titleParams ?? {});
  const action =
    input.bodyKey === undefined
      ? null
      : renderBody(
          resolveCatalogLabel(null, localeCatalog, catalogs.en, input.bodyKey),
          input.bodyParams ?? {},
          resolveCatalogLabel(null, localeCatalog, catalogs.en, UNNAMED_LABEL_KEY),
          input.bodyKey === "approval.itemDelete",
        );
  const body =
    action === null || input.bodySuffixKey === undefined
      ? action
      : `${action} ${resolveCatalogLabel(null, localeCatalog, catalogs.en, input.bodySuffixKey)}`;

  let managed = false;
  if (resolvedKind) {
    try {
      requireManagedTransaction(client);
      managed = true;
    } catch {
      // The public writer also accepts clients in a caller-owned transaction.
    }
    await client.query("SAVEPOINT guidance_notification_write");
  }
  let savepointOpen = resolvedKind;
  try {
    const { rows } = await client.query<{ id: string; created_at: Date; inserted: boolean }>(
      `INSERT INTO notifications (user_id, kind, title, body, link_href, source_table, source_id, transition_instance, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       ON CONFLICT (tenant_id, user_id, source_table, source_id, kind, transition_instance)
         DO UPDATE SET source_table = notifications.source_table
       RETURNING id, created_at, (xmax = 0) AS inserted`,
      [
        input.userId,
        input.kind,
        title,
        body,
        input.linkHref,
        input.sourceTable,
        input.sourceId,
        input.transitionInstance,
        JSON.stringify(payload),
      ],
    );
    const row = rows[0];
    if (!row) throw new Error("writeNotification: upsert returned no row");
    if (row.inserted && resolvedKind) {
      if (driftKind !== "permission" && driftKind !== "behavior") throw new Error("Invalid guidance drift kind");
      const projectId = payload.projectItemId;
      if (typeof projectId !== "string") throw new Error("Missing guidance drift project");
      const [project] = await getItemsByIds(client, [projectId]);
      if (!project) throw new Error("Guidance drift project not found");
      const projectName = project.properties.name;
      if (typeof projectName !== "string") throw new Error("Guidance drift project has no name");
      const template = resolveCatalogLabel(
        null,
        localeCatalog,
        catalogs.en,
        `notification.guidanceResolved.${driftKind}`,
      );
      payload = { ...payload, kind: driftKind, resolutionTitle: interpolate(template, { project: projectName }) };
      const updated = await client.query(
        "UPDATE notifications SET payload = $2::jsonb WHERE id = $1 AND user_id = $3",
        [row.id, JSON.stringify(payload), input.userId],
      );
      if (updated.rowCount !== 1) throw new Error("Notification disappeared during enrichment");
    }
    if (row.inserted) await enqueueNotificationFanout(client, row.id);
    if (savepointOpen) {
      await client.query("RELEASE SAVEPOINT guidance_notification_write");
      savepointOpen = false;
    }
    if (row.inserted && (!resolvedKind || managed))
      runAfterCommit(client, () => notifyNotificationCreated({ userId: input.userId, notificationId: row.id }));
    return row.id;
  } catch (error) {
    if (!resolvedKind) throw error;
    const cleanupErrors: unknown[] = [];
    if (savepointOpen) {
      try {
        await client.query("ROLLBACK TO SAVEPOINT guidance_notification_write");
        await client.query("RELEASE SAVEPOINT guidance_notification_write");
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length === 0) throw error;
    }
    if (managed) {
      try {
        markManagedTransactionRollbackOnly(client, error);
      } catch (markError) {
        cleanupErrors.push(markError);
      }
    }
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      cleanupErrors.push(rollbackError);
    }
    if (cleanupErrors.length) {
      throw new AggregateError([error, ...cleanupErrors], "Notification cleanup failed; connection may be unsafe", {
        cause: error,
      });
    }
    throw error;
  }
}
