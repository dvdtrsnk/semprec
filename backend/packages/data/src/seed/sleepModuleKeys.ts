/**
 * Canonical keys and `databases.owner_module_id` values of the three system databases of the sleep module
 * (issue #1776). The module that declares them is `sleep` (`sleep/sleepModuleManifest.ts`).
 */
export const SLEEP_SETTINGS_MODULE_ID = "sleepSettings";
export const SLEEP_PLANS_MODULE_ID = "sleepPlans";
export const SLEEP_NIGHTS_MODULE_ID = "sleepNights";

/** The key of the one-to-one relation property from `sleepSettings` to the Areas database (issue gh-1833). */
export const SLEEP_SETTINGS_AREA_KEY = "area";
