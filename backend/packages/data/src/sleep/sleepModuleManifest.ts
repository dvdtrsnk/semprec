import type { ModuleDatabaseDescriptor, ModuleManifest } from "@semprec/module-registry";
import { SLEEP_NIGHTS_MODULE_ID, SLEEP_PLANS_MODULE_ID, SLEEP_SETTINGS_MODULE_ID } from "../seed/sleepModuleKeys.js";
import { SLEEP_RESYNC_TASK_NAME } from "./sleepResync.js";

export { handleSleepResync, sleepResyncPayloadSchema } from "./sleepResync.js";
export { sleepNightPut, sleepNightsGet } from "./sleepRouteHandlers.js";

/**
 * The descriptors of the three sleep databases (issue #1776). None declares an overview or a switcher
 * position, so each resolves `clientVisible` false and is in neither client list.
 * `seed/seedSleepModule.ts` creates each database with the key declared here and names its default view
 * with the name declared here.
 */
export const SLEEP_DATABASE_DESCRIPTORS = {
  settings: { key: SLEEP_SETTINGS_MODULE_ID, name: "Sleep settings" },
  plans: { key: SLEEP_PLANS_MODULE_ID, name: "Sleep plans" },
  nights: { key: SLEEP_NIGHTS_MODULE_ID, name: "Sleep nights" },
} as const satisfies Record<string, ModuleDatabaseDescriptor>;

/**
 * Manifest of the sleep module (issue #1776): three system databases seeded by `seed/seedSleepModule.ts` and
 * owned by one system project. The labels of the databases, of their properties and options, and the names
 * of the two seeded plans are in `i18n/` beside this file. Its custom routes are `GET /api/sleep/nights`
 * (issue gh-1809) and `PUT /api/sleep/nights/:night` (issue gh-1835), both in `sleepRouteHandlers.ts`. Its one task is `sleep.resync`
 * (issue gh-1838), `sleepResync.ts`, which the hooks of `sleepWriteHooks.ts` enqueue.
 */
export const manifest: ModuleManifest = {
  id: "sleep",
  version: "1.0.0",
  name: "Sleep",
  removable: false,
  systemProject: true,
  databases: [SLEEP_DATABASE_DESCRIPTORS.settings, SLEEP_DATABASE_DESCRIPTORS.plans, SLEEP_DATABASE_DESCRIPTORS.nights],
  capabilities: [],
  agentTools: [],
  taskNames: [
    {
      name: SLEEP_RESYNC_TASK_NAME,
      payloadSchemaExport: "sleepResyncPayloadSchema",
      handlerExport: "handleSleepResync",
      queueAffinity: "api",
    },
  ],
  customRoutes: [
    {
      name: "sleepNights",
      method: "GET",
      path: "/api/sleep/nights",
      handlerExport: "sleepNightsGet",
      // The response aggregates the settings, the plans, the night exceptions and the tenant's time zone into
      // resolved nights; it is not an item of any database, so the generic item reads cannot express it.
      justification: "transactional-semantics",
    },
    {
      name: "sleepNightPut",
      method: "PUT",
      path: "/api/sleep/nights/:night",
      handlerExport: "sleepNightPut",
      // A find-or-create and a patch of the night's one exception under the per-night lock, answered with the
      // resolved night, for callers that hold no item version.
      justification: "transactional-semantics",
    },
  ],
};
