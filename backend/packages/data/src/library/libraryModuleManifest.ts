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
 * Retrofit manifest (module-contract issue #227) for the library module (issue #25): Books
 * and Movies/TV, two instantiations of the generic library contract (see
 * `libraryModuleContract.ts` — an older, unrelated "contract" concept: per-instance
 * property-key slots, not this `ModuleManifest`), sharing `item_automation`
 * (`0005_library_module.sql`) and the `library-grid` view type
 * (`views/libraryGridViewType.ts`). Its cover/metadata heartbeat actions
 * (`core.libraryMetadataTrigger`, `core.libraryMetadataRetrySweep`,
 * `libraryMetadataActions.ts`) and job (`processLibraryMetadata`,
 * `CORE_TASK_NAMES.LIBRARY_METADATA_PROCESS`) are registered as core actions/tasks, not
 * module-declared ones — the same reason the docs manifest (#226) excludes its cron tasks —
 * so this manifest declares no `heartbeatActions`/`taskNames`. Authoring this manifest
 * changes no behavior.
 */
/**
 * Status chips after an "All" chip, labelled `quickFilter.<database>.<status>` (issue #1647). Neither
 * library database has a default chip.
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
  migrations: ["0005_library_module.sql"],
  customRoutes: [
    {
      name: "libraryAutomationRetry",
      method: "POST",
      path: "/api/items/:id/automation/retry",
      handlerExport: "createLibraryAutomationRetryRouteHandler",
      // Issue #1793: in one transaction clears the item's manual cover choice, sets its automation row to pending
      // (a locked one too) and enqueues the metadata job, which no single generic item write can do.
      justification: "transactional-semantics",
    },
    {
      name: "libraryCoverCandidatesList",
      method: "GET",
      path: "/api/items/:id/cover-candidates",
      handlerExport: "createLibraryCoverCandidatesListRouteHandler",
      // Issue #1812: reads the candidates the metadata job stored for one Books or Movies item; no generic read
      // returns that table, and the route makes no request to an external service.
      justification: "single-consumer-read",
    },
    {
      name: "libraryCoverCandidatesRefresh",
      method: "POST",
      path: "/api/items/:id/cover-candidates/refresh",
      handlerExport: "createLibraryCoverCandidatesRefreshRouteHandler",
      // Issue #1812: in one transaction sets the item's automation row to pending and enqueues the metadata job.
      justification: "transactional-semantics",
    },
    {
      name: "libraryCoverCandidateSelect",
      method: "POST",
      path: "/api/items/:id/cover-candidates/:index/select",
      handlerExport: "createLibraryCoverCandidateSelectRouteHandler",
      // Issue #1812: stores the downloaded image as a blob and writes the cover properties in one transaction.
      justification: "transactional-semantics",
    },
  ],
};
