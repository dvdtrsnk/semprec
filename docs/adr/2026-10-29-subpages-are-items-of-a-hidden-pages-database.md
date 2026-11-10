---
status: accepted
date: 2026-10-29
area: [backend]
supersedes: []
superseded-by: null
---

# Subpages are items of a hidden `pages` database

## Context

A page is the Yjs document of an item. `docs.item_id` is `NOT NULL` and a unique index allows at most one document per item (`backend/packages/data/src/db/migrations/0003_docs.sql`). A page is therefore reachable only through its item, and a page that stands on its own needs an item of its own. [[2026-10-28-page-operation-family]] reserves `subpageCount` and `breadcrumbs[]` for subpages and defers where subpages live to this decision.

Three existing mechanisms rule out the obvious shapes:

- **Breadcrumbs.** `getItemPath` (`backend/packages/data/src/chokePoint/itemReads.ts`) follows `databases.parent_item_id` and stops at the first database it meets twice. A chain of items that all live in one database therefore ends after one link.
- **An inline database per parent.** Each page with subpages would add an items partition and a write that locks the shared `databases` table. A partition attach waits for other tenants' writes to that table ([[2026-10-08-items-partitions-attached-under-share-update-exclusive]]).
- **One document for a whole tree.** `WS /api/sync` (`backend/packages/realtime/src/docSync.ts`) opens at most 32 documents per connection (`MAX_OPEN_DOCS_PER_CONNECTION`). A subtree of blocks inside one document would make the socket open the whole tree.

A custom module route may not be CRUD over module data ([[2026-09-11-module-manifest-custom-routes]]), so pages get no CRUD route. Their operations belong to the generic catalog of [[2026-10-28-page-operation-family]].

[[2026-10-28-block-model-for-page-documents]] gives a `page` block no `text` field and leaves the meaning of `pageId` to this decision. Decision 3 amends that field contract and changes nothing else in it.

The implementation is spread over later issues. The page operations are implemented by #1676, #1722, #1725 and #1715. Deletion, restore and orphan handling are implemented by #1723, #1763, #1855 and #1749. The delete impact preview (#1856) and the proposal options (#1959) build on the same model.

## Decision

### 1. Storage

- Each tenant has one hidden system database, `pages`, with owner module id `pages`. The docs module manifest (`backend/packages/data/src/docs/docsModuleManifest.ts`) will declare it with no overview and no switcher order, so no collection list shows it.
- The database is created on first use, when the first subpage is created, under a Postgres advisory lock. The tenant seed does not create it, so no tenant backfill is needed.
- Each subpage is one item of the `pages` database, with one document of kind `page`. The item id is the page id, and the page's address is `semprec://page/<itemId>`. The existing item link `semprec://items/<uuid>` (`backend/packages/data/src/docs/assertItemLinksExist.ts`) uses a different prefix, so the two forms cannot be mistaken for each other.

Rejected: an inline database under every parent. Each page with subpages would then add an items partition and a write to the shared `databases` table (Context). Rejected: a subtree of blocks inside one document. The sync socket would open the whole tree, trash and search would work on the whole document instead of on a single page, and a link would name only a block id, with no item to trash or restore.

### 2. Parent link

- The Pages item has the system-owned text property `parentItemId`, which names the host item or the parent page. Breadcrumbs walk this property, so reading the ancestors of a subpage loads no document.
- Subpage breadcrumbs therefore do not use `getItemPath`, which follows database parents (Context).

Rejected: a relation property. It would add edge hooks and cardinality triggers without a gain. Rejected: an inline database per parent (decision 1).

The link is a text value, not a relation, so the database does not check that the item it names exists. Orphans are handled by decision 5.

### 3. Page block shape

- A `page` block has the block type `page`, the field `pageId` (the id of its Pages item) and the field `text`. `text` is a `Y.Text` that carries the title as plain text, with no `bold`, `italic`, `code` or `link` attributes.
- This amends [[2026-10-28-block-model-for-page-documents]], which gives `page` blocks no `text` field. This ADR adds only that field. The amended ADR is accepted, so its body and frontmatter are unchanged, and it is not superseded because none of its other decisions is reversed.

Rejected: a `page` block with no text, with the title held only on the Pages item. The editor changes the title in the parent document, so the parent must hold the text. Rejected: formatted title text. The mirror on the Pages item is a title property, which holds plain text, so the parent text has to match it.

### 4. Title source

- The text of the `page` block in the parent document is the source of truth.
- The `title` property of the Pages item is a mirror. `page.rename` writes it, and so does a post-commit job that runs after a parent document changes. The job is debounced by 10 seconds, as the design note of #1322 specifies.
- Trash, export, item reads, search and breadcrumbs read the mirror and do not load the parent document.
- The mirror can lag the parent by the debounce interval plus the job's run time.
- This narrows section 6 of [[2026-10-28-page-operation-family]]. That section says `page.rename` writes `meta.title` of the page's document. For a subpage, `page.rename` writes the text of the parent's block and the mirror, and the title of a subpage is not read from `meta` of its own document. The section still holds for pages that are not subpages. The family ADR's body is unchanged.

Rejected: the Pages item's `title` as the source. The title is edited in the parent document, so a source on the item would need a second path into that document.

### 5. Lifecycle

- Creating a subpage, duplicating a page and renaming it are page operations of the generic catalog: `page.createSubpage`, `page.duplicate` and `page.rename` ([[2026-10-28-page-operation-family]]). Pages have no CRUD route.
- Deleting a page is the generic `item.delete` with domain hooks. It is one of the five destructive operations ([[2026-09-18-non-destructive-generic-operations-bypass-agent-approval]]), so an agent's delete waits for approval, as [[2026-10-29-agent-page-write-policy]] requires for page deletion. Restoring uses the generic item restore with the same hooks.
- Deleting a host trashes its subpages through the same hooks.
- A `page` block removed directly through the sync socket leaves an orphan: a Pages item that no parent block names. A sweep trashes orphans.

Rejected: a page-specific delete operation. It would need its own approval classification, and the generic `item.delete` already has one.

### 6. Single owner of the Pages fields

- The `title` and `parentItemId` properties of the Pages item are system-owned, with owner process `pages`.
- Both writers of `title`, `page.rename` and the mirror job, must write under that owner process. When a system write names its owner process, the choke point rejects a write whose process is not the property's owner (`backend/packages/data/src/chokePoint/itemWrites.ts`). Both writers therefore name `pages`, and the field keeps one owner, as [[2026-09-10-single-writer-ownership-model]] requires. A rename is a user action, and the owner process carries it out. It adds no second writer.
- The blocks of a page's document belong to the docs module, the owner of page content ([[2026-10-28-page-operation-family]], section 2). They are not fields of the Pages item.

### 7. Hosts

- Full editors can hold subpages: project notes, Journal days and periods, areas, events, pages of items, and subpages.
- A light editor is the Markdown editor of a text property, without subpages (#1675). It rejects `page` blocks. The Markdown parser rejects a `page` line when `allowPage` is false (`shared/block-model/src/markdown.ts`).

Rejected: subpages under a light editor. A light property stores a Markdown string, never a document (#1675), and a subpage needs a document of its own.

### 8. Limits

- Depth is not limited.
- A page must never be its own ancestor.
- Duplication is capped. The cap is set by #1722.

Rejected: a fixed depth limit. The use cases nest without a known bound (a project note holds a checklist, which holds notes for a version), and the parent link needs no bound in order to be read.

## Consequences

- The first subpage of a tenant creates the `pages` database and with it an items partition. That attach takes the lock on `databases` that [[2026-10-08-items-partitions-attached-under-share-update-exclusive]] describes. Later subpages are items of an existing database and create no partition.
- Breadcrumbs, the trash list, export, item reads and search read `parentItemId` and `title` of Pages items. None of them loads the parent document.
- A page's title exists twice: in the parent, which is the source, and on the Pages item, which is the mirror. Decision 4 gives the lag.
- A `page` block carries `text`. The block-model validation and registry therefore accept `text` on `page` blocks and still reject inline attributes there (#1676).
- The hidden database has no list and no switcher entry.
