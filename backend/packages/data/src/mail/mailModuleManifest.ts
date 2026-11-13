export { createMailboxListRouteHandler, createMailboxDetailRouteHandler } from "./mailboxRouteHandlers.js";
export { createMailboxPasswordConnectRouteHandler } from "./mailboxPasswordRouteHandlers.js";
export { createMailContactsRouteHandler } from "./mailContactsRoute.js";
export {
  createMailThreadDetailRouteHandler,
  createMailThreadFacetsRouteHandler,
  createMailThreadListRouteHandler,
  createMailThreadReadRouteHandler,
} from "./mailThreadRoutes.js";
export { createMailAutonomousSendProjectsRouteHandler } from "./mailAutonomousSendRouteHandlers.js";
export {
  createMailDraftCreateRouteHandler,
  createMailDraftDiscardRouteHandler,
  createMailDraftReadRouteHandler,
  createMailDraftUpdateRouteHandler,
} from "./mailDraftRouteHandlers.js";
export {
  createMailboxReauthorizeRouteHandler,
  createMailOauthCompleteRouteHandler,
  createMailOauthStartRouteHandler,
} from "./mailOauthRouteHandlers.js";
export { createMailSummaryRouteHandler } from "./mailSummary.js";
export { createMailFolderListRouteHandler } from "./mailFolderList.js";
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
export { createMailboxRemovalRouteHandler } from "./mailboxRemoval.js";

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
      name: "mailboxPasswordConnect",
      method: "POST",
      path: "/api/mail/mailboxes",
      handlerExport: "createMailboxPasswordConnectRouteHandler",
      // Issue gh-1736: after the login is verified, creates the Mailboxes item, its sealed password, its server
      // settings, its sync state and its first sync job in one transaction.
      justification: "transactional-semantics",
    },
    {
      name: "mailThreadList",
      method: "GET",
      path: "/api/mail/threads",
      handlerExport: "createMailThreadListRouteHandler",
      justification: "single-consumer-read",
    },
    {
      name: "mailThreadFacets",
      method: "GET",
      path: "/api/mail/threads/facets",
      handlerExport: "createMailThreadFacetsRouteHandler",
      // Issue gh-1747: the filter bar's thread counts per area and per project, from one statement. Declared
      // before `mailThreadDetail`, whose `:threadId` also matches this path: the first declared match answers
      // (docs/adr/2026-11-10-custom-routes-are-matched-in-declaration-order.md).
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
      name: "mailThreadRead",
      method: "POST",
      path: "/api/mail/threads/:threadId/read",
      handlerExport: "createMailThreadReadRouteHandler",
      // Issue gh-1865: marks every incoming message of a conversation read, or its last incoming message
      // unread, through the item update path in one transaction, and sends one thin invalidation after the commit.
      justification: "transactional-semantics",
    },
    {
      name: "mailDraftCreate",
      method: "POST",
      path: "/api/mail/drafts",
      handlerExport: "createMailDraftCreateRouteHandler",
      // Issue gh-1867: creates the Emails item, its `mail_drafts` row and its Drafts folder edge in one transaction.
      justification: "transactional-semantics",
    },
    {
      name: "mailDraftRead",
      method: "GET",
      path: "/api/mail/drafts/:id",
      handlerExport: "createMailDraftReadRouteHandler",
      // Issue gh-1867: the draft as the compose window shows it, joined from the Emails item and its `mail_drafts` row.
      justification: "single-consumer-read",
    },
    {
      name: "mailDraftUpdate",
      method: "PATCH",
      path: "/api/mail/drafts/:id",
      handlerExport: "createMailDraftUpdateRouteHandler",
      // Issue gh-1867: rewrites the Emails item's system-owned display fields and the `mail_drafts` row under one
      // version check in one transaction.
      justification: "transactional-semantics",
    },
    {
      name: "mailDraftDiscard",
      method: "DELETE",
      path: "/api/mail/drafts/:id",
      handlerExport: "createMailDraftDiscardRouteHandler",
      // Issue gh-1867: trashes the Emails item and deletes its `mail_drafts` row in one transaction.
      justification: "transactional-semantics",
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
    {
      name: "mailOauthStart",
      method: "POST",
      path: "/api/mail/mailboxes/oauth/start",
      handlerExport: "createMailOauthStartRouteHandler",
      // Issue gh-1686: stores a one-time sign-in state with its sealed verifier and answers the provider's
      // authorization URL. It writes a row of the mail module's own table and no item.
      justification: "transactional-semantics",
    },
    {
      name: "mailOauthComplete",
      method: "POST",
      path: "/api/mail/mailboxes/oauth/complete",
      handlerExport: "createMailOauthCompleteRouteHandler",
      // Issue gh-1686: consumes the state, then creates the Mailboxes item, its sealed refresh token, its
      // sync state and its first sync job in one transaction. Issue gh-1742: for a state that carries a
      // mailbox id it replaces that mailbox's refresh token and queues its sync in one transaction instead.
      justification: "transactional-semantics",
    },
    {
      name: "mailboxReauthorize",
      method: "POST",
      path: "/api/mail/mailboxes/:id/reauthorize",
      handlerExport: "createMailboxReauthorizeRouteHandler",
      // Issue gh-1742: checks the mailbox and stores a one-time sign-in state that carries its id in one
      // transaction, and answers the provider's authorization URL. It writes no item.
      justification: "transactional-semantics",
    },
    {
      name: "mailSummary",
      method: "GET",
      path: "/api/mail/summary",
      handlerExport: "createMailSummaryRouteHandler",
      // Issue gh-1688: thread and mailbox counts from one statement, over the thread list's own predicates.
      justification: "single-consumer-read",
    },
    {
      name: "mailFolderList",
      method: "GET",
      path: "/api/mail/mailboxes/:id/folders",
      handlerExport: "createMailFolderListRouteHandler",
      // Issue gh-1689: the sidebar's folder rows of one mailbox, with the unread thread count and the message
      // count of every folder from one statement.
      justification: "single-consumer-read",
    },
    {
      name: "mailboxRemoval",
      method: "DELETE",
      path: "/api/mail/mailboxes/:id",
      handlerExport: "createMailboxRemovalRouteHandler",
      // One transaction over the Mailboxes item and four side tables (issue gh-1690): the trash, the
      // `syncStatus` write and the deletes of the credential, the sync state, the folder sync state
      // and the server settings. The generic item delete cannot express it.
      justification: "transactional-semantics",
    },
  ],
};
