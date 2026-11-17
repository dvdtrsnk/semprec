import type { ModuleDatabaseDescriptor, ModuleManifest } from "@semprec/module-registry";
import { SLEEP_NIGHTS_MODULE_ID, SLEEP_PLANS_MODULE_ID, SLEEP_SETTINGS_MODULE_ID } from "../seed/sleepModuleKeys.js";
import { SLEEP_RESYNC_TASK_NAME } from "./sleepResync.js";

export { handleSleepResync, sleepResyncPayloadSchema } from "./sleepResync.js";
export {
  createSleepNightSetTool,
  createSleepNightsGetTool,
  sleepNightSetArgsSchema,
  sleepNightsGetArgsSchema,
} from "./sleepAgentTools.js";
export { sleepNightPut, sleepNightsGet } from "./sleepRouteHandlers.js";

/** No overview or switcher position, so `clientVisible` resolves false; `seed/seedSleepModule.ts` uses these keys and names. */
export const SLEEP_DATABASE_DESCRIPTORS = {
  settings: { key: SLEEP_SETTINGS_MODULE_ID, name: "Sleep settings" },
  plans: { key: SLEEP_PLANS_MODULE_ID, name: "Sleep plans" },
  nights: { key: SLEEP_NIGHTS_MODULE_ID, name: "Sleep nights" },
} as const satisfies Record<string, ModuleDatabaseDescriptor>;

/** `sleepNightSet` declares no approval: it only creates or updates sleep night items. Database grants gate reads and writes. */
export const manifest: ModuleManifest = {
  id: "sleep",
  version: "1.0.0",
  name: "Sleep",
  removable: false,
  systemProject: true,
  databases: [SLEEP_DATABASE_DESCRIPTORS.settings, SLEEP_DATABASE_DESCRIPTORS.plans, SLEEP_DATABASE_DESCRIPTORS.nights],
  capabilities: ["sleep.read", "sleep.write"],
  agentTools: [
    {
      name: "sleepNightsGet",
      handlerExport: "createSleepNightsGetTool",
      argumentSchemaExport: "sleepNightsGetArgsSchema",
      capability: "sleep.read",
      approval: "none",
      riskClass: "read",
    },
    {
      name: "sleepNightSet",
      handlerExport: "createSleepNightSetTool",
      argumentSchemaExport: "sleepNightSetArgsSchema",
      capability: "sleep.write",
      approval: "none",
      riskClass: "write",
    },
  ],
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
      // Aggregates settings, plans, exceptions and time zone into resolved nights, which no generic item read expresses.
      justification: "transactional-semantics",
    },
    {
      name: "sleepNightPut",
      method: "PUT",
      path: "/api/sleep/nights/:night",
      handlerExport: "sleepNightPut",
      // Find-or-create and patch under the per-night lock, for callers that hold no item version.
      justification: "transactional-semantics",
    },
  ],
};
