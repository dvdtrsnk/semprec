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
  createCaptureInboxItemRouteHandler,
  createConfirmProposalRouteHandler,
  createInboxCardsCountRouteHandler,
  createInboxCardsRouteHandler,
  createInboxTypesRouteHandler,
  createItemOriginRouteHandler,
  createProposalOptionsRouteHandler,
  createReopenProposalRouteHandler,
  createRecomputeProposalRouteHandler,
  createRejectProposalRouteHandler,
  createResetProposalOverridesRouteHandler,
  createReviseProposalRouteHandler,
  createUpdateProposalValuesRouteHandler,
} from "./inboxRouteHandlers.js";

/**
 * Declares the Inbox, Inbox item types and Processing proposals databases, the `journal-inbox` view type and the
 * `semprec.tick` `onItemEvent` heartbeat action. The `journalInboxRecompute` job is core-registered, so no
 * `taskNames` are declared; `onItemEvent` is a core rule kind, so no `heartbeatRuleKinds` either.
 *
 * `proposal`, `status` and `history` are system-owned: confirm, reject and revise go through `proposalActions.ts`. The
 * agent tools are limited to the run's own item-thread card and keep it a proposal, so they need no approval.
 *
 * Each card `kind` has exactly one producer: `inbox` (including `transcription` recording cards) by `semprec.tick`,
 * `transcript` by `semprec-transcribe`, `mailThread` by the mail module (`mail/threadTaskProposals.ts`). Everything
 * after creation stays with this module's proposal actions, with two exceptions owned by `semprec-transcribe`:
 * - `transcriptCardRecompute` rewrites a `transcript` card after a user instruction, under the card's row lock, never a
 *   `confirmed`/`rejected` card or another kind;
 * - speaker suggestion refresh rewrites a `needsClarification` speaker card the user never touched, under a `NOWAIT`
 *   row lock, when the transcript's Event or its participants change.
 *
 * A recording card's confirm runs in `semprec-api`: it records the recording intake, moves the attachment into Files
 * and enqueues the transcription; `semprec-transcribe` then creates the `transcript` card and Transcripts row.
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
  customRoutes: [
    {
      name: "confirmProposal",
      method: "POST",
      path: "/api/proposals/:id/confirm",
      handlerExport: "createConfirmProposalRouteHandler",
      // Destination writes (plus a stored credential for an MCP server proposal) commit with the status transition.
      justification: "transactional-semantics",
    },
    {
      name: "rejectProposal",
      method: "POST",
      path: "/api/proposals/:id/reject",
      handlerExport: "createRejectProposalRouteHandler",
      // `status` is system-owned, so the generic item update cannot express this.
      justification: "transactional-semantics",
    },
    {
      name: "reopenProposal",
      method: "POST",
      path: "/api/proposals/:id/reopen",
      handlerExport: "createReopenProposalRouteHandler",
      // Reopening a `confirmed` card reverses its recorded writes across several databases (items to Trash, edges,
      // page blocks, a created MCP server's credential) in the same transaction as the status transition.
      justification: "transactional-semantics",
    },
    {
      name: "reviseProposal",
      method: "POST",
      path: "/api/proposals/:id/revise",
      handlerExport: "createReviseProposalRouteHandler",
      // Validated against live destination state, committed with the lock check and status transition.
      justification: "transactional-semantics",
    },
    {
      name: "updateProposalValues",
      method: "PATCH",
      path: "/api/proposals/:id/values",
      handlerExport: "createUpdateProposalValuesRouteHandler",
      // The generic item update refuses the system-owned `proposal`, `status` and `history`.
      justification: "transactional-semantics",
    },
    {
      name: "resetProposalOverrides",
      method: "POST",
      path: "/api/proposals/:id/reset-overrides",
      handlerExport: "createResetProposalOverridesRouteHandler",
      // The generic item update refuses the system-owned `proposal`, `status` and `history`.
      justification: "transactional-semantics",
    },
    {
      name: "recomputeProposal",
      method: "POST",
      path: "/api/proposals/:id/recompute",
      handlerExport: "createRecomputeProposalRouteHandler",
      // The tick is queued in the same transaction as the `computing` status.
      justification: "transactional-semantics",
    },
    {
      name: "listProposalOptions",
      method: "GET",
      path: "/api/proposals/:id/options",
      handlerExport: "createProposalOptionsRouteHandler",
      justification: "single-consumer-read",
    },
    {
      name: "getItemOrigin",
      method: "GET",
      path: "/api/items/:id/origin",
      handlerExport: "createItemOriginRouteHandler",
      justification: "single-consumer-read",
    },
    {
      name: "changeInboxItemType",
      method: "PUT",
      path: "/api/inbox/items/:id/type",
      handlerExport: "createChangeInboxItemTypeRouteHandler",
      // Edge replacement, cleared manual values, `computing` status and the tick trigger commit together.
      justification: "transactional-semantics",
    },
    {
      name: "captureInboxItem",
      method: "POST",
      path: "/api/inbox/items",
      handlerExport: "createCaptureInboxItemRouteHandler",
      // Item, `type` edge and attachments commit together, which the generic create cannot express.
      justification: "transactional-semantics",
    },
    {
      name: "listInboxTypes",
      method: "GET",
      path: "/api/inbox-types",
      handlerExport: "createInboxTypesRouteHandler",
      justification: "single-consumer-read",
    },
    {
      name: "listInboxCards",
      method: "GET",
      path: "/api/inbox/cards",
      handlerExport: "createInboxCardsRouteHandler",
      justification: "single-consumer-read",
    },
    {
      name: "countInboxCards",
      method: "GET",
      path: "/api/inbox/cards/count",
      handlerExport: "createInboxCardsCountRouteHandler",
      justification: "single-consumer-read",
    },
  ],
  // The MCP server card's editor, carried here until an MCP module manifest exists.
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
