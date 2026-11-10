/**
 * The canonical key, `owner_module_id` and owner process of the hidden Pages database (issue #1676,
 * docs/adr/2026-10-29-subpages-are-items-of-a-hidden-pages-database.md). Kept here, beside the other module key files,
 * because the choke point reads it to follow a subpage's parent link and may not import the `docs/` folder
 * (`chokepoint-knows-no-domain`); `docs/pagesDatabase.ts` re-exports it as `PAGES_MODULE_ID`.
 */
export const PAGES_MODULE_ID = "pages";
