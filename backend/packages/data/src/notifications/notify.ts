import type { PoolClient } from "pg";
import { loadModuleCatalogs, resolveCatalogLabel, type ModuleCatalogs } from "@semprec/module-registry";
import { getUserById } from "../auth/usersStore.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import { enqueueNotificationFanout } from "./notificationFanoutJob.js";
import type { NotificationKind } from "./notificationKinds.js";

let catalogsPromise: Promise<ModuleCatalogs> | undefined;

/** Lazily loaded once per process and reused — `notifications/i18n/{cs,en}.json` never changes at runtime. */
function getNotificationCatalogs(): Promise<ModuleCatalogs> {
  catalogsPromise ??= loadModuleCatalogs(import.meta.url);
  return catalogsPromise;
}

/** Replaces each `{param}` placeholder in `template` with `params[param]`, leaving an unmatched placeholder untouched. */
function interpolate(template: string, params: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, key: string) => params[key] ?? placeholder);
}

export interface WriteNotificationInput {
  /** Who this notification is for. Resolved by the producer — the writer never guesses a recipient. */
  userId: string;
  kind: NotificationKind;
  /** Substituted into the `notification.<kind>.title` catalog entry (e.g. `{name}` for `heartbeat_error`). */
  titleParams?: Readonly<Record<string, string>>;
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
   * Identifies *this* state transition of `(sourceTable, sourceId, kind)` — replaying the same
   * transition (a redelivered/retried queue job re-running the same failure) must not duplicate
   * the notification, while a later, independent transition on the same source must still insert
   * a new row. `scheduler/sweep.ts`'s `heartbeat_error` producer uses the firing queue job's own
   * `id`, which is stable across that job's retries and distinct for every new fire.
   */
  transitionInstance: string;
}

/**
 * Runs on the caller's transaction client (never opens its own transaction): rolling back the
 * caller's transaction rolls this insert back with it, and committing it exposes both together.
 * Deduplicates on `(sourceTable, sourceId, kind, transitionInstance)` via the unique index from
 * migration 0030 — a replay is a silent no-op, never a second row.
 *
 * On an actual (non-replay) insert, also enqueues issue #151's `notificationFanout` job in the
 * same transaction — "this notification exists" and "delivery will be attempted" land together,
 * the same commit-coupling pattern as `decideAndEnqueueApprovalRequest`. A replay enqueues
 * nothing new: the row already has a notification, and that notification's fanout job (keyed by
 * its own id) either already ran or is already queued.
 */
export async function writeNotification(client: PoolClient, input: WriteNotificationInput): Promise<void> {
  const user = await getUserById(client, input.userId);
  if (!user) {
    throw new Error(`writeNotification: no user with id "${input.userId}"`);
  }

  const catalogs = await getNotificationCatalogs();
  const locale = toManifestLocale(user.locale);
  const titleTemplate = resolveCatalogLabel(null, catalogs[locale], catalogs.en, `notification.${input.kind}.title`);
  const title = interpolate(titleTemplate, input.titleParams ?? {});

  const { rows } = await client.query(
    `INSERT INTO notifications (user_id, kind, title, link_href, source_table, source_id, transition_instance)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (source_table, source_id, kind, transition_instance) DO NOTHING
     RETURNING id`,
    [input.userId, input.kind, title, input.linkHref, input.sourceTable, input.sourceId, input.transitionInstance],
  );

  const notificationId = (rows[0] as { id: string } | undefined)?.id;
  if (notificationId) {
    await enqueueNotificationFanout(client, notificationId);
  }
}
