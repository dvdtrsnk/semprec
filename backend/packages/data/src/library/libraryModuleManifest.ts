import type { ModuleDatabaseDescriptor, ModuleManifest } from "@semprec/module-registry";
import { LIBRARY_GRID_VIEW_TYPE } from "../views/libraryGridViewType.js";
import { BOOKS_MODULE_ID, MOVIES_MODULE_ID } from "../seed/libraryModuleKeys.js";

export { createLibraryAutomationRetryRouteHandler } from "./libraryAutomationRouteHandlers.js";
export {
  createLibraryCoverCandidateSelectRouteHandler,
  createLibraryCoverCandidatesListRouteHandler,
  createLibraryCoverCandidatesRefreshRouteHandler,
} from "./libraryCoverCandidateRouteHandlers.js";

/**
 * Books and Movies/TV share `item_automation` and the `library-grid` view type. Their metadata heartbeat actions
 * and job are registered as core actions/tasks, so this manifest declares no `heartbeatActions`/`taskNames`.
 */
function statusChips(database: string, statuses: string[]): NonNullable<ModuleDatabaseDescriptor["quickFilters"]> {
  return [
    { key: "all", labelKey: `quickFilter.${database}.all` },
    ...statuses.map((status) => ({
      key: status,
      labelKey: `quickFilter.${database}.${status}`,
      filter: { type: "in", property: "status", value: [status] },
    })),
  ];
}

export const manifest: ModuleManifest = {
  id: "library",
  version: "1.3.0",
  name: "Library",
  removable: false,
  systemProject: true,
  databases: [
    {
      key: BOOKS_MODULE_ID,
      name: "Books",
      icon: "book-open",
      color: "#A2845E",
      overviewOrder: 7,
      switcherOrder: null,
      clientVisible: true,
      quickFilters: statusChips(BOOKS_MODULE_ID, ["toRead", "reading", "read"]),
    },
    {
      key: MOVIES_MODULE_ID,
      name: "Movies/TV",
      icon: "film",
      color: "#FF6482",
      overviewOrder: 8,
      switcherOrder: null,
      clientVisible: true,
      quickFilters: statusChips(MOVIES_MODULE_ID, ["planned", "watching", "watched"]),
    },
  ],
  capabilities: [],
  agentTools: [],
  viewTypes: [LIBRARY_GRID_VIEW_TYPE],
  customRoutes: [
    {
      name: "libraryAutomationRetry",
      method: "POST",
      path: "/api/items/:id/automation/retry",
      handlerExport: "createLibraryAutomationRetryRouteHandler",
      // Clears the manual cover choice, resets automation to pending and enqueues the job in one transaction.
      justification: "transactional-semantics",
    },
    {
      name: "libraryCoverCandidatesList",
      method: "GET",
      path: "/api/items/:id/cover-candidates",
      handlerExport: "createLibraryCoverCandidatesListRouteHandler",
      // No generic read returns the candidates table; no external request is made.
      justification: "single-consumer-read",
    },
    {
      name: "libraryCoverCandidatesRefresh",
      method: "POST",
      path: "/api/items/:id/cover-candidates/refresh",
      handlerExport: "createLibraryCoverCandidatesRefreshRouteHandler",
      justification: "transactional-semantics",
    },
    {
      name: "libraryCoverCandidateSelect",
      method: "POST",
      path: "/api/items/:id/cover-candidates/:index/select",
      handlerExport: "createLibraryCoverCandidateSelectRouteHandler",
      // Stores the downloaded image as a blob and writes the cover properties in one transaction.
      justification: "transactional-semantics",
    },
  ],
};
