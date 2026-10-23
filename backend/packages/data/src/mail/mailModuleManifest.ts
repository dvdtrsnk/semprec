import type { ModuleManifest } from "@semprec/module-registry";
import { MAILBOX_CLIENT_VIEW_TYPE } from "../views/mailboxClientViewType.js";
import { EMAILS_MODULE_ID, FOLDERS_MODULE_ID, MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";
import { MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID, MAIL_REINDEX_PERSON_EMAILS_ACTION_ID } from "./personLinkingActions.js";

export { createNoopMailLiveSyncLifecycleFactory } from "./mailLiveSyncRoot.js";

/**
 * Retrofit manifest (module-contract issue #227) for mail sync and mailbox (issue #26):
 * Mailboxes/Folders/Emails (`0006_mail_sync.sql`, `0007_mail_delivered_to_and_dsn.sql`) and
 * the `mailbox-client` view type (`views/mailboxClientViewType.ts`). `newEmail`'s
 * `core.agentRun` heartbeat and the sync/reindex jobs registered under `CORE_TASK_NAMES`
 * (`mailAccountSync`, `mailAccountSyncSweep`, `mailSearchReindexSweep`,
 * `mailLegacyEmailMigration` — all wired in `worker.ts`'s `createCoreTaskList`) are
 * core-registered, not module-declared, the same reason the docs manifest (#226) excludes
 * its cron tasks — so this manifest declares no `taskNames`. `mail.reindexPersonEmails` and
 * `mail.linkPeopleByEmail` (`personLinkingActions.ts`) are this module's own heartbeat
 * actions, not core's, so they are declared here.
 *
 * `workers` declares the per-mailbox sync worker (module-contract issue #110's generic
 * per-active-row mechanism, `moduleWorkers.ts`): one instance per active Mailboxes row,
 * each hosting exactly that account's live-sync lifecycle — `createNoopMailLiveSyncLifecycleFactory`
 * (`mailLiveSyncRoot.ts`) already returns exactly that one-account-at-a-time factory, unlike
 * `createMailLiveSyncRoot`, which is its own singleton composition root that discovers and
 * hosts every account itself. Wiring a real reconciler up to this declaration (supplying the
 * active Mailboxes row ids) is a later composition root's job, per `moduleWorkers.ts`'s own
 * scope note — this manifest only declares the worker's existence and entry point. Authoring
 * this manifest changes no behavior.
 */
export const manifest: ModuleManifest = {
  id: "mailSync",
  version: "1.0.0",
  name: "Mail Sync",
  removable: false,
  systemProject: true,
  databases: [
    { key: MAILBOXES_MODULE_ID, name: "Mailboxes" },
    { key: FOLDERS_MODULE_ID, name: "Folders" },
    { key: EMAILS_MODULE_ID, name: "Emails" },
  ],
  capabilities: [],
  agentTools: [],
  viewTypes: [MAILBOX_CLIENT_VIEW_TYPE],
  heartbeatActions: [MAIL_REINDEX_PERSON_EMAILS_ACTION_ID, MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID],
  workers: [{ name: "semprec-mailsync", handlerExport: "createNoopMailLiveSyncLifecycleFactory" }],
  migrations: ["0006_mail_sync.sql", "0007_mail_delivered_to_and_dsn.sql"],
};
