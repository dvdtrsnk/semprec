export { createMailboxListRouteHandler, createMailboxDetailRouteHandler } from "./mailboxRouteHandlers.js";
export { createMailContactsRouteHandler } from "./mailContactsRoute.js";
export { createMailThreadDetailRouteHandler, createMailThreadListRouteHandler } from "./mailThreadRoutes.js";
export { createMailAutonomousSendProjectsRouteHandler } from "./mailAutonomousSendRouteHandlers.js";
import type { ModuleManifest } from "@semprec/module-registry";
import { MAILBOX_CLIENT_VIEW_TYPE } from "../views/mailboxClientViewType.js";
import {
  EMAILS_MODULE_ID,
  FOLDERS_MODULE_ID,
  MAILBOXES_MODULE_ID,
  THREADS_MODULE_ID,
} from "../seed/emailModuleKeys.js";
import { MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID, MAIL_REINDEX_PERSON_EMAILS_ACTION_ID } from "./personLinkingActions.js";

export { createNoopMailLiveSyncLifecycleFactory } from "./mailLiveSyncRoot.js";
export { createMailboxRemovalImpactRouteHandler } from "./mailboxRemovalImpact.js";

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
    { key: THREADS_MODULE_ID, name: "Threads" },
    { key: FOLDERS_MODULE_ID, name: "Folders" },
    {
      key: EMAILS_MODULE_ID,
      name: "Emails",
      icon: "envelope",
      color: "#007AFF",
      overviewOrder: null,
      switcherOrder: null,
      clientVisible: true,
    },
  ],
  capabilities: [],
  agentTools: [],
  viewTypes: [MAILBOX_CLIENT_VIEW_TYPE],
  heartbeatActions: [MAIL_REINDEX_PERSON_EMAILS_ACTION_ID, MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID],
  workers: [{ name: "semprec-mailsync", handlerExport: "createNoopMailLiveSyncLifecycleFactory" }],
  migrations: ["0006_mail_sync.sql", "0007_mail_delivered_to_and_dsn.sql"],
  customRoutes: [
    {
      name: "mailboxList",
      method: "GET",
      path: "/api/mail/mailboxes",
      handlerExport: "createMailboxListRouteHandler",
      justification: "single-consumer-read",
    },
    {
      name: "mailboxDetail",
      method: "GET",
      path: "/api/mail/mailboxes/:id",
      handlerExport: "createMailboxDetailRouteHandler",
      justification: "single-consumer-read",
    },
    {
      name: "mailThreadList",
      method: "GET",
      path: "/api/mail/threads",
      handlerExport: "createMailThreadListRouteHandler",
      justification: "single-consumer-read",
    },
    {
      name: "mailThreadDetail",
      method: "GET",
      path: "/api/mail/threads/:threadId",
      handlerExport: "createMailThreadDetailRouteHandler",
      // Shaped for exactly one consumer, the Mail detail: the thread's list-row header with every
      // message, sanitized at read time, and its attachments' blobs and Files items.
      justification: "single-consumer-read",
    },
    {
      name: "mailAutonomousSendProjects",
      method: "GET",
      path: "/api/mail/autonomous-send-projects",
      handlerExport: "createMailAutonomousSendProjectsRouteHandler",
      // Read only: the account detail's list of projects allowed to send without confirmation. The
      // permission is switched on per project on the server; the app offers no way to change it.
      justification: "single-consumer-read",
    },
    {
      name: "mailContacts",
      method: "GET",
      path: "/api/mail/contacts",
      handlerExport: "createMailContactsRouteHandler",
      justification: "single-consumer-read",
    },
    {
      name: "mailboxRemovalImpact",
      method: "GET",
      path: "/api/mail/mailboxes/:id/removal-impact",
      handlerExport: "createMailboxRemovalImpactRouteHandler",
      // Shaped for exactly one consumer, the mailbox removal confirmation (issue gh-1501): four counts
      // from one statement over Emails, Folders, mail_message_meta and mail_attachments.
      justification: "single-consumer-read",
    },
  ],
};
