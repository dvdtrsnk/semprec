import type { ModuleManifest } from "@semprec/module-registry";
import { JOURNAL_INBOX_VIEW_TYPE } from "../views/journalInboxViewType.js";
import {
  INBOX_ITEM_TYPES_MODULE_ID,
  INBOX_MODULE_ID,
  PROCESSING_PROPOSALS_MODULE_ID,
} from "../seed/inboxPipelineKeys.js";
import { SEMPREC_TICK_ACTION_ID } from "./inboxTickAction.js";

export {
  createInboxProposalGetTool,
  createInboxProposalReviseTool,
  createInboxProposalSplitTool,
  inboxProposalGetArgsSchema,
  inboxProposalReviseArgsSchema,
  inboxProposalSplitArgsSchema,
} from "./inboxAgentTools.js";
export {
  createChangeInboxItemTypeRouteHandler,
  createConfirmProposalRouteHandler,
  createInboxCardsCountRouteHandler,
  createInboxCardsRouteHandler,
  createInboxTypesRouteHandler,
  createRejectProposalRouteHandler,
  createReviseProposalRouteHandler,
  createUpdateProposalValuesRouteHandler,
} from "./inboxRouteHandlers.js";

/**
 * Retrofit manifest (module-contract issue #227) for the Inbox pipeline (issues #101-#106):
 * Inbox, Inbox item types, and Processing proposals (`0010_inbox_type_processing.sql` — the
 * only DDL-adjacent change; the three databases themselves are seeded through the generic
 * databases/properties mechanism, like the ten hardcoded databases) and the `journal-inbox`
 * view type (`views/journalInboxViewType.ts`). `semprec.tick` (`inboxTickAction.ts`) is this
 * module's own `onItemEvent` heartbeat action (create/update/delete on Inbox), so it is
 * declared here; the recompute job it can enqueue (`journalInboxRecompute`,
 * `CORE_TASK_NAMES.JOURNAL_INBOX_RECOMPUTE`) is core-registered, not module-declared, the
 * same reason the docs manifest (#226) excludes its cron tasks — so this manifest declares
 * no `taskNames`. `onItemEvent` itself is a core-defined heartbeat rule kind, not a new one
 * this module contributes, so it is not declared under `heartbeatRuleKinds` either.
 * `proposal`, `status` and `history` are system-owned, so a generic item update cannot write them: confirm, reject and
 * revise go through the proposal actions (`proposalActions.ts`) and their routes. The two agent tools are limited to the
 * card of the calling run's own item thread: `inbox.proposal.get` reads it, and `inbox.proposal.revise` (issue #1906)
 * replaces its envelope through the revise path. A revision keeps the card a proposal, and nothing is created in a
 * target database before the user confirms, so the tool needs no approval.
 *
 * Ownership handoff for Processing proposals
 * (`docs/adr/2026-09-23-speaker-mappings-are-edges-proposed-on-transcript-cards.md`, superseding
 * `docs/adr/2026-09-23-processing-proposals-card-creation-owned-per-kind.md`): each card `kind`
 * has exactly one producer process that creates its cards — `inbox` by `semprec.tick`,
 * `transcript` by `semprec-transcribe`, from its match step (`transcription/transcriptEventMatch.ts`)
 * and its speaker suggestion step (`transcription/transcriptSpeakerSuggestion.ts`). `mailThread` cards (source
 * relation `sourceThread`, issue gh-2034) have no producer process yet: issue #2035 decides it
 * (`docs/adr/2026-11-14-a-mail-thread-card-proposes-one-task-of-a-thread-and-is-confirmed-as-a-user-write.md`).
 * Everything after creation (confirm/reject/revise) stays with this module's proposal actions, with two additions.
 * First (`docs/adr/2026-11-14-transcript-cards-are-recomputed-by-their-producer-on-instruction.md`): when a user's
 * instruction is recorded on a `transcript` card, `semprec-transcribe` also rewrites that card's `aiProposal`,
 * `aiVersion`, `proposal` and `history` (and the `userOverrides`, `userEditedKeys` and `status` that follow) in its
 * `transcriptCardRecompute` task, under the card's row lock, and never a card that is `confirmed`, `rejected` or of
 * another kind. Second
 * (`docs/adr/2026-11-14-speaker-suggestions-are-asked-again-when-the-event-or-its-participants-change.md`): when a
 * transcript's Event or the Event's participants change, `semprec-transcribe` refreshes, in its
 * `transcriptSpeakerSuggestion` task and in the pipeline's speaker step (`refreshClarificationCard` of
 * `proposeSpeakerMappings`), the `context`, `proposal`, `aiProposal`, `aiVersion`, `status` and `history` of a speaker
 * card that is still `needsClarification` and has no user entry in its history, under the card's `NOWAIT` row lock; a
 * card of any other status, or one the user touched, is never rewritten. The production sites above are unchanged:
 * the recompute task creates no card, and the suggestion task creates the cards of the speaker suggestion step.
 */
export const manifest: ModuleManifest = {
  id: "inboxPipeline",
  version: "1.0.0",
  name: "Inbox Pipeline",
  removable: false,
  systemProject: true,
  databases: [
    { key: INBOX_MODULE_ID, name: "Inbox" },
    { key: INBOX_ITEM_TYPES_MODULE_ID, name: "Inbox item types" },
    { key: PROCESSING_PROPOSALS_MODULE_ID, name: "Processing proposals" },
  ],
  capabilities: [],
  agentTools: [
    {
      name: "inbox.proposal.get",
      handlerExport: "createInboxProposalGetTool",
      argumentSchemaExport: "inboxProposalGetArgsSchema",
      approval: "none",
      riskClass: "read",
    },
    {
      name: "inbox.proposal.revise",
      handlerExport: "createInboxProposalReviseTool",
      argumentSchemaExport: "inboxProposalReviseArgsSchema",
      approval: "none",
      riskClass: "write",
    },
    {
      name: "inbox.proposal.split",
      handlerExport: "createInboxProposalSplitTool",
      argumentSchemaExport: "inboxProposalSplitArgsSchema",
      approval: "none",
      riskClass: "write",
    },
  ],
  viewTypes: [JOURNAL_INBOX_VIEW_TYPE],
  heartbeatActions: [SEMPREC_TICK_ACTION_ID],
  migrations: ["0010_inbox_type_processing.sql"],
  customRoutes: [
    {
      name: "confirmProposal",
      method: "POST",
      path: "/api/proposals/:id/confirm",
      handlerExport: "createConfirmProposalRouteHandler",
      // A cross-destination write (item creation/patch plus, for an MCP server proposal, a
      // stored credential) committed in one transaction with the proposal's own status
      // transition — issue #239's "cross-database write in one transaction" justification.
      justification: "transactional-semantics",
    },
    {
      name: "rejectProposal",
      method: "POST",
      path: "/api/proposals/:id/reject",
      handlerExport: "createRejectProposalRouteHandler",
      // A status transition, its history entry and the Journal recompute committed in one
      // transaction, which the generic item update cannot express (`status` is system-owned).
      justification: "transactional-semantics",
    },
    {
      name: "reviseProposal",
      method: "POST",
      path: "/api/proposals/:id/revise",
      handlerExport: "createReviseProposalRouteHandler",
      // The replacement envelope is validated against live destination state, and the lock check and the
      // status transition commit with it in one transaction.
      justification: "transactional-semantics",
    },
    {
      name: "updateProposalValues",
      method: "PATCH",
      path: "/api/proposals/:id/values",
      handlerExport: "createUpdateProposalValuesRouteHandler",
      // The proposal's lock, the merge into its user overrides and the history entry commit in one
      // transaction, which a generic item update cannot express (it refuses the system-owned
      // `proposal`, `status` and `history` of a Processing proposal).
      justification: "transactional-semantics",
    },
    {
      name: "changeInboxItemType",
      method: "PUT",
      path: "/api/inbox/items/:id/type",
      handlerExport: "createChangeInboxItemTypeRouteHandler",
      // The replacement of the `type` edge, the clearing of the card's manual values, its `computing` status and the
      // trigger of the tick commit in one transaction, which no generic edge write can express.
      justification: "transactional-semantics",
    },
    {
      name: "listInboxTypes",
      method: "GET",
      path: "/api/inbox-types",
      handlerExport: "createInboxTypesRouteHandler",
      // Shaped for exactly one consumer, the capture UI's type picker — not a generic
      // list-items-in-a-database query.
      justification: "single-consumer-read",
    },
    {
      name: "listInboxCards",
      method: "GET",
      path: "/api/inbox/cards",
      handlerExport: "createInboxCardsRouteHandler",
      // The Inbox stack merges two sources (cards and pending approvals) in one fixed order — not a
      // generic list-items-in-a-database query.
      justification: "single-consumer-read",
    },
    {
      name: "countInboxCards",
      method: "GET",
      path: "/api/inbox/cards/count",
      handlerExport: "createInboxCardsCountRouteHandler",
      // The number of open Inbox cards for the header, the badge and the new-chat shortcut — not a
      // generic count of items in a database.
      justification: "single-consumer-read",
    },
  ],
  // The MCP server card's editor (`docs/adr/2026-10-25-server-driven-inbox-editor-schema.md`).
  // This Inbox manifest carries it until an MCP module manifest exists. Declaring it changes no
  // behaviour: nothing evaluates `required`, `when` or `timeHiddenWhen` until #1928 and #1934.
  editorSchemas: {
    mcp: {
      groups: [
        {
          key: "server",
          fields: [
            {
              key: "name",
              control: "text",
              labelKey: "editor.mcp.name.label",
              placeholderKey: "editor.mcp.name.placeholder",
              required: true,
            },
            {
              key: "transport",
              control: "seg",
              options: ["http", "stdio"],
              labelKey: "editor.mcp.transport.label",
            },
            {
              key: "url",
              control: "text",
              inputType: "url",
              labelKey: "editor.mcp.url.label",
              placeholderKey: "editor.mcp.url.placeholder",
              required: true,
              when: { field: "transport", equals: "http" },
            },
            {
              key: "command",
              control: "text",
              labelKey: "editor.mcp.command.label",
              placeholderKey: "editor.mcp.command.placeholder",
              required: true,
              when: { field: "transport", equals: "stdio" },
            },
            {
              key: "credential",
              control: "secret",
              labelKey: "editor.mcp.credential.label",
              placeholderKey: "editor.mcp.credential.placeholder",
              required: true,
              when: { field: "transport", equals: "http" },
            },
          ],
        },
        {
          key: "projects",
          fields: [
            {
              key: "mcpProjects",
              control: "multi",
              labelKey: "editor.mcp.mcpProjects.label",
              optionsSource: "mcpProjects",
            },
          ],
        },
      ],
    },
  },
};
