export { createMailboxListRouteHandler, createMailboxDetailRouteHandler } from "./mailboxRouteHandlers.js";
export { createMailboxPasswordConnectRouteHandler } from "./mailboxPasswordRouteHandlers.js";
export { createMailContactsRouteHandler } from "./mailContactsRoute.js";
export {
  createMailThreadArchiveRouteHandler,
  createMailThreadDetailRouteHandler,
  createMailThreadFacetsRouteHandler,
  createMailThreadFlagRouteHandler,
  createMailThreadListRouteHandler,
  createMailThreadReadRouteHandler,
  createMailThreadRestoreRouteHandler,
  createMailThreadTrashRouteHandler,
} from "./mailThreadRoutes.js";
export { createMailThreadTaskCreateRouteHandler } from "./mailThreadTaskRouteHandlers.js";
export { threadCompanyLinkResolver, threadProjectLinkResolver } from "./threadLinkRules.js";
export {
  createMailDraftCreateTool,
  createMailDraftSendTool,
  createMailDraftUpdateTool,
  createMailThreadGetTool,
  mailDraftCreateArgsSchema,
  mailDraftSendArgsSchema,
  mailDraftUpdateArgsSchema,
  mailThreadGetArgsSchema,
} from "./mailAgentTools.js";
export {
  handleMailTriageThreadProject,
  mailTriageThreadProjectPayloadSchema,
  setThreadProjectTriageRuntime,
} from "./threadProjectTriage.js";
export { handleMailSyncThreadTaskPeople, mailSyncThreadTaskPeoplePayloadSchema } from "./threadTaskPeople.js";
export { createMailAutonomousSendProjectsRouteHandler } from "./mailAutonomousSendRouteHandlers.js";
export {
  createMailDraftAttachmentAddRouteHandler,
  createMailDraftAttachmentRemoveRouteHandler,
  createMailDraftCreateRouteHandler,
  createMailDraftDiscardRouteHandler,
  createMailDraftReadRouteHandler,
  createMailDraftSendRouteHandler,
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
import { FILES_MODULE_ID, TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { THREAD_ATTACHMENT_PROJECT_RULE_KEY } from "./threadAttachmentLinks.js";
import { MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID, MAIL_REINDEX_PERSON_EMAILS_ACTION_ID } from "./personLinkingActions.js";
import { THREAD_COMPANY_LINK_RULE_KEY, THREAD_PROJECT_LINK_RULE_KEY } from "./threadLinkRules.js";
import { MAIL_SYNC_THREAD_TASK_PEOPLE_TASK } from "./threadTaskPeople.js";

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
 * its cron tasks — so the only `taskNames` entries are the module's own `mailTriageThreadProject` (issue gh-1872),
 * which `threadProjectTriage.ts` enqueues, and `mailSyncThreadTaskPeople` (issue gh-1923, `threadTaskPeople.ts`).
 * `mail.reindexPersonEmails` and
 * `mail.linkPeopleByEmail` (`personLinkingActions.ts`) are this module's own heartbeat
 * actions, not core's, so they are declared here.
 *
 * Its three draft agent tools (issue gh-1927, `mailAgentTools.ts`) are `mail.thread.get` (capability `mail.read`) and
 * `mail.draft.create` and `mail.draft.update` (capability `mail.draft`). A drafted mail stays in Semprec and nothing
 * sends it, so they declare no approval. The fourth, `mail.draft.send` (issue gh-1949, capability `mail.send`), is
 * declared without `requiresApproval` and without a risk class although it concerns an outbound mail: the session
 * runs its handler, which files the approval request of the send (issue gh-1913) and sends nothing, and the generic
 * deferral would put a second approval in front of that request
 * (docs/adr/2026-11-14-the-mail-send-tool-is-declared-without-deferral-and-files-its-own-approval-request.md).
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
  capabilities: ["mail.read", "mail.draft", "mail.send"],
  agentTools: [
    {
      name: "mail.thread.get",
      handlerExport: "createMailThreadGetTool",
      argumentSchemaExport: "mailThreadGetArgsSchema",
      capability: "mail.read",
      approval: "none",
      riskClass: "read",
    },
    // A draft stays in Semprec and nothing sends it, so creating and updating one needs no approval; sending is a
    // separate tool (docs/adr/2026-10-28-module-agent-tools-approval-and-grants.md).
    {
      name: "mail.draft.create",
      handlerExport: "createMailDraftCreateTool",
      argumentSchemaExport: "mailDraftCreateArgsSchema",
      capability: "mail.draft",
      approval: "none",
      riskClass: "write",
    },
    {
      name: "mail.draft.update",
      handlerExport: "createMailDraftUpdateTool",
      argumentSchemaExport: "mailDraftUpdateArgsSchema",
      capability: "mail.draft",
      approval: "none",
      riskClass: "write",
    },
    // Issue gh-1949. Not `requiresApproval`, not `approval: "always"` and not `outbound`: see the manifest docstring.
    {
      name: "mail.draft.send",
      handlerExport: "createMailDraftSendTool",
      argumentSchemaExport: "mailDraftSendArgsSchema",
      capability: "mail.send",
      approval: "none",
    },
  ],
  viewTypes: [MAILBOX_CLIENT_VIEW_TYPE],
  heartbeatActions: [MAIL_REINDEX_PERSON_EMAILS_ACTION_ID, MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID],
  workers: [{ name: "semprec-mailsync", handlerExport: "createNoopMailLiveSyncLifecycleFactory" }],
  migrations: ["0006_mail_sync.sql", "0007_mail_delivered_to_and_dsn.sql"],
  linkRules: [
    // A task made from a thread takes over the thread's project (issue gh-1900). Ownership handoff: `Tasks.project`
    // stays `owner: user`, and the `valueLinks` process writes it only while the task's value link for that property
    // is `on`. The rule runs in the transaction that writes the `Threads.tasks` edge (`mail/threadTasks.ts`). The task's
    // people are not a rule: see docs/adr/2026-11-14-a-task-made-from-a-mail-thread-inherits-its-project-and-people.md.
    {
      key: "taskProjectFromThread",
      source: { databaseKey: THREADS_MODULE_ID, propertyKey: "project" },
      target: { databaseKey: TASKS_MODULE_ID, propertyKey: "project" },
      via: { databaseKey: THREADS_MODULE_ID, relationKey: "tasks" },
    },
    // Issue gh-1869: a thread inherits its company from the sender of its first inbound message and its project
    // from its company. Neither is copied along a relation, so both rules name a resolver (`threadLinkRules.ts`)
    // that computes the value and declares the changes that make it stale. Ownership handoff: `Threads.company` and
    // `Threads.project` stay `owner: user`, and the `valueLinks` process writes them only while the thread's link
    // for that property is `on`.
    {
      key: THREAD_COMPANY_LINK_RULE_KEY,
      target: { databaseKey: THREADS_MODULE_ID, propertyKey: "company" },
      resolverExport: "threadCompanyLinkResolver",
    },
    {
      key: THREAD_PROJECT_LINK_RULE_KEY,
      target: { databaseKey: THREADS_MODULE_ID, propertyKey: "project" },
      resolverExport: "threadProjectLinkResolver",
    },
    // A file that a message of a thread brought takes over the thread's project (issue gh-1898). Ownership handoff:
    // `Files.projects` stays `owner: user`, and the `valueLinks` process writes it only while the file's value link for
    // that property is `on`. The rule runs in the transaction that writes the `Threads.attachments` edge at ingest
    // (`mail/attachments.ts`); a later change of the thread's project reaches the file through the `valueLinksPropagate`
    // job. See docs/adr/2026-11-14-an-attachment-inherits-the-project-of-its-thread-by-a-link-rule.md.
    {
      key: THREAD_ATTACHMENT_PROJECT_RULE_KEY,
      source: { databaseKey: THREADS_MODULE_ID, propertyKey: "project" },
      target: { databaseKey: FILES_MODULE_ID, propertyKey: "projects" },
      via: { databaseKey: THREADS_MODULE_ID, relationKey: "attachments" },
    },
  ],
  taskNames: [
    {
      // Issue gh-1872: Semp picks a project for a thread that inherited none. `ingest.ts` enqueues it after the first
      // inbound message of a new thread, delayed; the runtime binds the pool and the AI gateway it needs
      // (`setThreadProjectTriageRuntime`).
      name: "mailTriageThreadProject",
      payloadSchemaExport: "mailTriageThreadProjectPayloadSchema",
      handlerExport: "handleMailTriageThreadProject",
      queueAffinity: "api",
    },
    {
      // Adds a person who joined a thread's conversation to the people of its tasks (issue gh-1923); the edge changed
      // hook of `threadTaskPeople.ts` enqueues it.
      name: MAIL_SYNC_THREAD_TASK_PEOPLE_TASK,
      payloadSchemaExport: "mailSyncThreadTaskPeoplePayloadSchema",
      handlerExport: "handleMailSyncThreadTaskPeople",
      queueAffinity: "api",
    },
  ],
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
      name: "mailThreadTaskCreate",
      method: "POST",
      path: "/api/mail/threads/:threadId/tasks",
      handlerExport: "createMailThreadTaskCreateRouteHandler",
      // Issue gh-1900: with no name, names the task through the AI gateway outside any transaction and then, in one
      // transaction, checks that the thread did not change and writes the Tasks item, its `Threads.tasks` edge and the
      // inherited project and people.
      justification: "transactional-semantics",
    },
    {
      name: "mailThreadFlag",
      method: "POST",
      path: "/api/mail/threads/:threadId/flag",
      handlerExport: "createMailThreadFlagRouteHandler",
      // Issue gh-1893: flags the last incoming message of a conversation, or clears the flag on every message of
      // it, through the item update path in one transaction, and sends one thin invalidation after the commit.
      justification: "transactional-semantics",
    },
    {
      name: "mailThreadArchive",
      method: "POST",
      path: "/api/mail/threads/:threadId/archive",
      handlerExport: "createMailThreadArchiveRouteHandler",
      // Issue gh-1917: moves the Inbox messages of a conversation to the Archive folder of their mailboxes and records
      // each move for the provider, in one transaction, and sends one thin invalidation after the commit.
      justification: "transactional-semantics",
    },
    {
      name: "mailThreadTrash",
      method: "POST",
      path: "/api/mail/threads/:threadId/trash",
      handlerExport: "createMailThreadTrashRouteHandler",
      // Issue gh-1917: moves the messages of a conversation to the Trash folder of their mailboxes and records each
      // move for the provider, in one transaction, and sends one thin invalidation after the commit.
      justification: "transactional-semantics",
    },
    {
      name: "mailThreadRestore",
      method: "POST",
      path: "/api/mail/threads/:threadId/restore",
      handlerExport: "createMailThreadRestoreRouteHandler",
      // Issue gh-2033: moves the messages of a conversation that are in Archive or Trash back to the Inbox (incoming
      // mail) or Sent (the user's own mail) folder of their mailboxes and records each move for the provider, in one
      // transaction, and sends one thin invalidation after the commit.
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
      name: "mailDraftAttachmentAdd",
      method: "POST",
      path: "/api/mail/drafts/:id/attachments",
      handlerExport: "createMailDraftAttachmentAddRouteHandler",
      // Issue gh-1895: attaches a Files item to an unsent draft, or a copy of it over the same blob when another
      // email holds it, after the provider's size limit, in one transaction.
      justification: "transactional-semantics",
    },
    {
      name: "mailDraftAttachmentRemove",
      method: "DELETE",
      path: "/api/mail/drafts/:id/attachments/:fileItemId",
      handlerExport: "createMailDraftAttachmentRemoveRouteHandler",
      // Issue gh-1895: removes the attachment edge of an unsent draft in one transaction.
      justification: "transactional-semantics",
    },
    {
      name: "mailDraftSend",
      method: "POST",
      path: "/api/mail/drafts/:id/send",
      handlerExport: "createMailDraftSendRouteHandler",
      // Issue gh-1896: claims the draft, sends it through the mailbox's transport and, in one finalizing transaction,
      // moves it to Sent, links its people and sets the draft row's `sent_at`.
      justification: "transactional-semantics",
    },
    {
      name: "mailAutonomousSendProjects",
      method: "GET",
      path: "/api/mail/autonomous-send-projects",
      handlerExport: "createMailAutonomousSendProjectsRouteHandler",
      // Read only: the account detail's list of projects whose permission manifest holds `emailSendAutonomous`.
      // No send reads that grant in v1 (every agent send needs approval, issue gh-1913). The permission is
      // switched on per project on the server; the app offers no way to change it.
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
