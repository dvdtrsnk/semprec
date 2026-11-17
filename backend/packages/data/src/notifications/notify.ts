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

/** Loaded once per process; the catalogs never change at runtime. */
function getNotificationCatalogs(): Promise<ModuleCatalogs> {
  catalogsPromise ??= loadModuleCatalogs(import.meta.url);
  return catalogsPromise;
}

/** Rendered for a `null` body parameter, e.g. an item without a name. */
const UNNAMED_LABEL_KEY = "notification.body.unnamed";

export const ITEM_DELETE_IMPACT_BODY_KEY = "approval.itemDeleteImpact";

/** Leaves unmatched placeholders untouched. */
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
  /** Resolved by the producer; the writer never guesses a recipient. */
  userId: string;
  kind: NotificationKind;
  /** Substituted into `notification.<kind>.title`. */
  titleParams?: Readonly<Record<string, string>>;
  /** Rendered in the recipient's locale and stored; absent stores NULL. */
  bodyKey?: string;
  /** A `null` value renders as the unnamed label. */
  bodyParams?: Readonly<Record<string, string | number | null>>;
  bodySuffixKey?: string;
  /** Resolved by the producer (e.g. `?page=agent-run&id=...`); the writer has no routing knowledge. */
  linkHref: string | null;
  sourceTable: string;
  sourceId: string;
  /**
   * Identifies this transition of the source for this recipient: stable across retries (no
   * duplicate), distinct for every new transition (e.g. the firing queue job's id).
   */
  transitionInstance: string;
  /** Data a client renders without a round trip to the source row. Defaults to `{}`. */
  payload?: Record<string, unknown>;
}

/**
 * Runs in the caller's transaction. Deduplicates per recipient via
 * `notifications_tenant_dedupe_idx`: a replay is a silent no-op that returns the existing id.
 * A fresh insert enqueues the fanout job in the same transaction, so the row and its delivery
 * attempt commit together. The realtime hook fires after commit; resolved-guidance notifications
 * register it only in a managed transaction, which owns completion.
 *
 * `ON CONFLICT ... DO UPDATE` no-op plus `xmax = 0` always returns a row and tells whether it
 * was inserted.
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
          input.bodyKey === "approval.itemDelete" || input.bodyKey === ITEM_DELETE_IMPACT_BODY_KEY,
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
