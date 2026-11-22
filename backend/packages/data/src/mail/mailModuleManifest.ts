export { createMailboxListRouteHandler, createMailboxDetailRouteHandler } from "./mailboxRouteHandlers.js";
export {
  createMailboxPasswordConnectRouteHandler,
  createMailboxPasswordReplaceRouteHandler,
} from "./mailboxPasswordRouteHandlers.js";
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
  createMailDraftCreateUserTool,
  createMailDraftSendTool,
  createMailDraftSendUserTool,
  createMailDraftUpdateTool,
  createMailDraftUpdateUserTool,
  createMailSearchTool,
  createMailSearchUserTool,
  createMailThreadGetTool,
  createMailThreadGetUserTool,
  createMailThreadProposeTaskTool,
  mailDraftCreateArgsSchema,
  mailDraftSendArgsSchema,
  mailDraftUpdateArgsSchema,
  mailSearchArgsSchema,
  mailThreadGetArgsSchema,
  mailThreadProposeTaskArgsSchema,
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
export { createMailMessageContentRouteHandler } from "./mailMessageContent.js";
export { createMailAttachmentSaveRouteHandler } from "./mailAttachmentSave.js";
export { createMailSearchRouteHandler } from "./mailRemoteSearch.js";
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
 * Manifest for mail sync and mailboxes: Mailboxes/Folders/Emails and the `mailbox-client` view type. The sync and
 * reindex jobs and the `newEmail` heartbeat are core-registered, so `taskNames` lists only the module's own tasks;
 * `mail.reindexPersonEmails` and `mail.linkPeopleByEmail` are the module's own heartbeat actions.
 *
 * Agent tools: drafting tools declare no approval because a draft stays in Semprec. `mail.draft.send` declares no
 * `requiresApproval` and no risk class: its handler files the send's own approval request and sends nothing, so the
 * generic deferral would add a second approval. Over `/mcp` a human session runs the `mcp` handler as its user and a
 * run credential runs the regular handler as its run. `mail.thread.proposeTask` only writes an Inbox card; the user's
 * confirm creates the task.
 *
 * `workers` declares one per-mailbox sync worker per active Mailboxes row, hosting that account's lifecycle
 * (`createNoopMailLiveSyncLifecycleFactory`); this manifest only declares it.
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
  capabilities: ["mail.read", "mail.draft", "mail.send", "mail.taskProposal"],
  agentTools: [
    {
      name: "mail.thread.get",
      handlerExport: "createMailThreadGetTool",
      argumentSchemaExport: "mailThreadGetArgsSchema",
      capability: "mail.read",
      approval: "none",
      riskClass: "read",
      mcp: { humanHandlerExport: "createMailThreadGetUserTool" },
    },
    // Read-only like `mail.thread.get`, with its capability and exposure; it may ask the mail providers to search.
    {
      name: "mail.search",
      handlerExport: "createMailSearchTool",
      argumentSchemaExport: "mailSearchArgsSchema",
      capability: "mail.read",
      approval: "none",
      riskClass: "read",
      mcp: { humanHandlerExport: "createMailSearchUserTool" },
    },
    // A draft stays in Semprec and nothing sends it, so creating and updating one needs no approval.
    {
      name: "mail.draft.create",
      handlerExport: "createMailDraftCreateTool",
      argumentSchemaExport: "mailDraftCreateArgsSchema",
      capability: "mail.draft",
      approval: "none",
      riskClass: "write",
      mcp: { humanHandlerExport: "createMailDraftCreateUserTool" },
    },
    {
      name: "mail.draft.update",
      handlerExport: "createMailDraftUpdateTool",
      argumentSchemaExport: "mailDraftUpdateArgsSchema",
      capability: "mail.draft",
      approval: "none",
      riskClass: "write",
      mcp: { humanHandlerExport: "createMailDraftUpdateUserTool" },
    },
    // Not `requiresApproval`, not `approval: "always"` and not `outbound`: see the manifest docstring.
    {
      name: "mail.draft.send",
      handlerExport: "createMailDraftSendTool",
      argumentSchemaExport: "mailDraftSendArgsSchema",
      capability: "mail.send",
      approval: "none",
      // Over MCP a run credential's call files the request like a session's; a human session's call sends as the user.
      mcp: { humanHandlerExport: "createMailDraftSendUserTool" },
    },
    // Writes one Processing proposals card and its source edge and no task, so no approval is needed. The capability
    // is granted with the mail databases.
    {
      name: "mail.thread.proposeTask",
      handlerExport: "createMailThreadProposeTaskTool",
      argumentSchemaExport: "mailThreadProposeTaskArgsSchema",
      capability: "mail.taskProposal",
      approval: "none",
      riskClass: "write",
    },
  ],
  viewTypes: [MAILBOX_CLIENT_VIEW_TYPE],
  heartbeatActions: [MAIL_REINDEX_PERSON_EMAILS_ACTION_ID, MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID],
  workers: [{ name: "semprec-mailsync", handlerExport: "createNoopMailLiveSyncLifecycleFactory" }],
  linkRules: [
    // A task made from a thread takes over the thread's project. Ownership handoff: `Tasks.project` stays
    // `owner: user`; `valueLinks` writes it only while the task's value link is `on`. Runs in the transaction that
    // writes the `Threads.tasks` edge. The task's people are not a rule (`threadTaskPeople.ts`).
    {
      key: "taskProjectFromThread",
      source: { databaseKey: THREADS_MODULE_ID, propertyKey: "project" },
      target: { databaseKey: TASKS_MODULE_ID, propertyKey: "project" },
      via: { databaseKey: THREADS_MODULE_ID, relationKey: "tasks" },
    },
    // A thread inherits its company from the sender of its first inbound message and its project from its company.
    // Neither is copied along a relation, so both rules name a resolver (`threadLinkRules.ts`). Ownership handoff: the
    // fields stay `owner: user`; `valueLinks` writes them only while the thread's link is `on`.
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
    // A file a thread's message brought takes over the thread's project. Ownership handoff: `Files.projects` stays
    // `owner: user`; `valueLinks` writes it only while the file's link is `on`. Runs with the `Threads.attachments`
    // edge write at ingest; later project changes reach the file through the `valueLinksPropagate` job.
    {
      key: THREAD_ATTACHMENT_PROJECT_RULE_KEY,
      source: { databaseKey: THREADS_MODULE_ID, propertyKey: "project" },
      target: { databaseKey: FILES_MODULE_ID, propertyKey: "projects" },
      via: { databaseKey: THREADS_MODULE_ID, relationKey: "attachments" },
    },
  ],
  taskNames: [
    {
      // Semp picks a project for a thread that inherited none; enqueued delayed after a new thread's first inbound
      // message. The runtime binds the pool and AI gateway (`setThreadProjectTriageRuntime`).
      name: "mailTriageThreadProject",
      payloadSchemaExport: "mailTriageThreadProjectPayloadSchema",
      handlerExport: "handleMailTriageThreadProject",
      queueAffinity: "api",
    },
    {
      // Adds a person who joined a thread's conversation to the people of its tasks.
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
      // Creates the Mailboxes item, sealed password, server settings, sync state and first sync job in one transaction.
      justification: "transactional-semantics",
    },
    {
      name: "mailboxPasswordReplace",
      method: "PUT",
      path: "/api/mail/mailboxes/:id/password",
      handlerExport: "createMailboxPasswordReplaceRouteHandler",
      // Replaces the sealed password and server settings, clears the mail and calendar reauthorization state and
      // queues both syncs in one transaction.
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
      name: "mailSearch",
      method: "GET",
      path: "/api/mail/search",
      handlerExport: "createMailSearchRouteHandler",
      // The thread list's local search together with a search at each account's provider, read outside any
      // transaction; nothing is written.
      justification: "single-consumer-read",
    },
    {
      name: "mailThreadFacets",
      method: "GET",
      path: "/api/mail/threads/facets",
      handlerExport: "createMailThreadFacetsRouteHandler",
      // Declared before `mailThreadDetail`, whose `:threadId` also matches this path: the first declared match answers.
      justification: "single-consumer-read",
    },
    {
      name: "mailThreadDetail",
      method: "GET",
      path: "/api/mail/threads/:threadId",
      handlerExport: "createMailThreadDetailRouteHandler",
      justification: "single-consumer-read",
    },
    {
      name: "mailThreadRead",
      method: "POST",
      path: "/api/mail/threads/:threadId/read",
      handlerExport: "createMailThreadReadRouteHandler",
      justification: "transactional-semantics",
    },
    {
      name: "mailThreadTaskCreate",
      method: "POST",
      path: "/api/mail/threads/:threadId/tasks",
      handlerExport: "createMailThreadTaskCreateRouteHandler",
      // Names the task through the AI gateway outside any transaction, then checks the thread did not change and
      // writes the task, its edge and inherited values in one transaction.
      justification: "transactional-semantics",
    },
    {
      name: "mailThreadFlag",
      method: "POST",
      path: "/api/mail/threads/:threadId/flag",
      handlerExport: "createMailThreadFlagRouteHandler",
      justification: "transactional-semantics",
    },
    {
      name: "mailThreadArchive",
      method: "POST",
      path: "/api/mail/threads/:threadId/archive",
      handlerExport: "createMailThreadArchiveRouteHandler",
      justification: "transactional-semantics",
    },
    {
      name: "mailThreadTrash",
      method: "POST",
      path: "/api/mail/threads/:threadId/trash",
      handlerExport: "createMailThreadTrashRouteHandler",
      justification: "transactional-semantics",
    },
    {
      name: "mailThreadRestore",
      method: "POST",
      path: "/api/mail/threads/:threadId/restore",
      handlerExport: "createMailThreadRestoreRouteHandler",
      justification: "transactional-semantics",
    },
    {
      name: "mailDraftCreate",
      method: "POST",
      path: "/api/mail/drafts",
      handlerExport: "createMailDraftCreateRouteHandler",
      justification: "transactional-semantics",
    },
    {
      name: "mailDraftRead",
      method: "GET",
      path: "/api/mail/drafts/:id",
      handlerExport: "createMailDraftReadRouteHandler",
      justification: "single-consumer-read",
    },
    {
      name: "mailDraftUpdate",
      method: "PATCH",
      path: "/api/mail/drafts/:id",
      handlerExport: "createMailDraftUpdateRouteHandler",
      justification: "transactional-semantics",
    },
    {
      name: "mailDraftDiscard",
      method: "DELETE",
      path: "/api/mail/drafts/:id",
      handlerExport: "createMailDraftDiscardRouteHandler",
      justification: "transactional-semantics",
    },
    {
      name: "mailDraftAttachmentAdd",
      method: "POST",
      path: "/api/mail/drafts/:id/attachments",
      handlerExport: "createMailDraftAttachmentAddRouteHandler",
      justification: "transactional-semantics",
    },
    {
      name: "mailDraftAttachmentRemove",
      method: "DELETE",
      path: "/api/mail/drafts/:id/attachments/:fileItemId",
      handlerExport: "createMailDraftAttachmentRemoveRouteHandler",
      justification: "transactional-semantics",
    },
    {
      name: "mailDraftSend",
      method: "POST",
      path: "/api/mail/drafts/:id/send",
      handlerExport: "createMailDraftSendRouteHandler",
      // Claims the draft, sends it, then moves it to Sent, links people and sets `sent_at` in one finalizing
      // transaction.
      justification: "transactional-semantics",
    },
    {
      name: "mailAutonomousSendProjects",
      method: "GET",
      path: "/api/mail/autonomous-send-projects",
      handlerExport: "createMailAutonomousSendProjectsRouteHandler",
      // Read only: projects whose permission manifest holds `emailSendAutonomous`. No send reads that grant yet; the
      // app offers no way to change it.
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
      justification: "single-consumer-read",
    },
    {
      name: "mailOauthStart",
      method: "POST",
      path: "/api/mail/mailboxes/oauth/start",
      handlerExport: "createMailOauthStartRouteHandler",
      // Writes a row of the module's own table and no item.
      justification: "transactional-semantics",
    },
    {
      name: "mailOauthComplete",
      method: "POST",
      path: "/api/mail/mailboxes/oauth/complete",
      handlerExport: "createMailOauthCompleteRouteHandler",
      // Consumes the state, then creates the mailbox (or, for a reauthorization state, replaces its refresh token)
      // in one transaction.
      justification: "transactional-semantics",
    },
    {
      name: "mailboxReauthorize",
      method: "POST",
      path: "/api/mail/mailboxes/:id/reauthorize",
      handlerExport: "createMailboxReauthorizeRouteHandler",
      justification: "transactional-semantics",
    },
    {
      name: "mailSummary",
      method: "GET",
      path: "/api/mail/summary",
      handlerExport: "createMailSummaryRouteHandler",
      justification: "single-consumer-read",
    },
    {
      name: "mailFolderList",
      method: "GET",
      path: "/api/mail/mailboxes/:id/folders",
      handlerExport: "createMailFolderListRouteHandler",
      justification: "single-consumer-read",
    },
    {
      name: "mailMessageContent",
      method: "GET",
      path: "/api/mail/messages/:emailId/content",
      handlerExport: "createMailMessageContentRouteHandler",
      // Reads one message's body; for an older message it is fetched from the provider and kept in the module's own
      // cache table, no item is written.
      justification: "single-consumer-read",
    },
    {
      name: "mailAttachmentSave",
      method: "POST",
      path: "/api/mail/messages/:emailId/attachments/:attachmentId/save",
      handlerExport: "createMailAttachmentSaveRouteHandler",
      // Records the fetched bytes on the attachment row and creates the Files item with its Email and Thread edges in
      // one transaction.
      justification: "transactional-semantics",
    },
    {
      name: "mailboxRemoval",
      method: "DELETE",
      path: "/api/mail/mailboxes/:id",
      handlerExport: "createMailboxRemovalRouteHandler",
      // The trash, the `syncStatus` write and the side-table deletes in one transaction, which the generic item delete
      // cannot express.
      justification: "transactional-semantics",
    },
  ],
};
