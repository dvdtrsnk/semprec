import type { ModuleManifest } from "@semprec/module-registry";
import { JOURNAL_INBOX_VIEW_TYPE } from "../views/journalInboxViewType.js";
import {
  INBOX_ITEM_TYPES_MODULE_ID,
  INBOX_MODULE_ID,
  PROCESSING_PROPOSALS_MODULE_ID,
} from "../seed/inboxPipelineKeys.js";
import { SEMPREC_TICK_ACTION_ID } from "./inboxTickAction.js";

export { createConfirmProposalRouteHandler, createInboxTypesRouteHandler } from "./inboxRouteHandlers.js";

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
 * this module contributes, so it is not declared under `heartbeatRuleKinds` either. There is
 * no dedicated agent tool for confirm/reject/revise (issue #105) — those go through the
 * generic item-update choke point, the same "single path" every other module uses — so
 * `agentTools` stays empty. Authoring this manifest changes no behavior.
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
  agentTools: [],
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
      name: "listInboxTypes",
      method: "GET",
      path: "/api/inbox-types",
      handlerExport: "createInboxTypesRouteHandler",
      // Shaped for exactly one consumer, the capture UI's type picker — not a generic
      // list-items-in-a-database query.
      justification: "single-consumer-read",
    },
  ],
};
