/**
 * The canonical key and `owner_module_id` of the Invitations system database (issue gh-1901), the same
 * convention as `emailModuleKeys.ts`. It is the database's own key, not the id of the module that declares
 * it: that module is `calendar` (`CALENDAR_MODULE_ID`), which is also the owner process of the database's
 * system-owned properties.
 */
export const INVITATIONS_MODULE_ID = "invitations";
