/**
 * Key, `owner_module_id` and owner process of the hidden Pages database. Lives here because the choke
 * point needs it to follow a subpage's parent link and may not import `docs/` (`chokepoint-knows-no-domain`);
 * `docs/pagesDatabase.ts` re-exports it.
 */
export const PAGES_MODULE_ID = "pages";
