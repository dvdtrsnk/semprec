import type { ModuleDatabaseDescriptor, ModuleManifest } from "@semprec/module-registry";
import { SLEEP_NIGHTS_MODULE_ID, SLEEP_PLANS_MODULE_ID, SLEEP_SETTINGS_MODULE_ID } from "../seed/sleepModuleKeys.js";

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
 * of the two seeded plans are in `i18n/` beside this file.
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
};
