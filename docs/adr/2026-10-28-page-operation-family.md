---
status: accepted
date: 2026-10-28
area: [backend]
supersedes: []
superseded-by: null
---

# Page operation family in the generic operation catalog

## Context

A page is the Yjs document of an item (`docs.item_id`, kind `page`) whose
content follows [[2026-10-28-block-model-for-page-documents]]. Today a page
cannot be reached over HTTP: `getDocByItemId` and `getOrCreateDoc`
(`backend/packages/data/src/docs/docsStore.ts`) are internal,
`docs/docsModuleManifest.ts` declares no routes and no agent tools, and
`WS /api/sync` is the only editing channel. Later issues need one agreed set of
page operations: reading a page as a summary or Markdown, ensuring it exists,
replacing and inserting content, creating subpages, duplicating, renaming,
restoring a version and listing what Semp changed.

Operations that clients, MCP and agents call go through the closed generic
operation catalog (`GENERIC_OPERATION_NAMES` in
`backend/packages/shared/src/genericOperations/operationNames.ts`, bound by
`GENERIC_OPERATION_BINDINGS` and classified in `capabilities.ts`), executed by
the one `GenericApplicationPort` implementation of
[[2026-09-17-generic-application-service-port]] and shared by REST, MCP
([[2026-09-18-mcp-json-rpc-transport-for-the-generic-operation-catalog]]) and
agent tools. Approval for agent calls follows
[[2026-09-18-non-destructive-generic-operations-bypass-agent-approval]]. Custom
routes in a module manifest are allowed only for `transactional-semantics` or
`single-consumer-read`, never CRUD (`module-registry/src/manifest.ts`).

## Decision

### 1. The family

Nine operations join the catalog, one per implementing issue. Every path is
relative to the item; `:id` is the item id and becomes `itemId` in the
operation input.

| Operation | HTTP | Input beyond `itemId` | Implemented by |
|---|---|---|---|
| `page.get` | `GET /api/items/:id/page` | query `format` (`summary` or `markdown`, default `summary`), optional `limit` | #1615 (summary), #1678 (Markdown) |
| `page.ensure` | `PUT /api/items/:id/page` | none | #1616 |
| `page.replace` | `PUT /api/items/:id/page/content` | Markdown body, optional `expectedLastEditedAt` | its own issue |
| `page.insert` | `POST /api/items/:id/page/blocks` | Markdown body, optional position | #1679 |
| `page.createSubpage` | `POST /api/items/:id/page/subpages` | optional title | #1676 |
| `page.duplicate` | `POST /api/items/:id/page/duplicate` | optional target | its own issue |
| `page.rename` | `PATCH /api/items/:id/page/title` | `title` | its own issue |
| `page.restoreVersion` | `POST /api/items/:id/page/restore` | `at` (ISO timestamp) | #1617 |
| `page.changes` | `GET /api/items/:id/page/changes` | optional `limit` | its own issue |

`page.restoreVersion` takes `{itemId, at}`; the HTTP binding fills `itemId` from
the path and `at` from the body. The catalog count in `operationNames.ts` grows
by exactly one in each issue that implements an operation (29 today); an
operation that is not implemented yet is not registered, so the catalog never
lists a name without a binding. Request and response schemas are fixed by the
implementing issue, not by this table.

### 2. Why the catalog

Reads and writes of a page are item sub-resources that REST, MCP and agent
tools all need with identical input validation, capability check and approval
handling. Registering them in the catalog gives that through
`GenericApplicationPort` and `genericBinding.ts`.

Rejected: custom routes in the docs module manifest. The manifest rule allows
custom routes only for `transactional-semantics` or `single-consumer-read`; a
page read or replace is neither (several transports consume it, and replace,
insert and rename are CRUD on page content). Custom routes would also give MCP
and agent tools a second, hand-maintained validation path and would bypass the
catalog's approval metadata. Trade-off accepted: the closed catalog, its
bindings and the capability table change for every operation, and a catalog
change is shared code rather than module-local.

The write path respects [[2026-09-10-single-writer-ownership-model]]: page
content has one owner, the docs module in `packages/data`. Every write
operation reaches the document through the choke-point; no transport or other
module writes `doc_updates` directly.

### 3. Capability and approval class

A new pair of capabilities is added to `CAPABILITY_IDS` by the first
implementing issue: `core.page.read` and `core.page.write`. Rejected: reusing
`core.item.read` and `core.item.write`. A grant of `core.item.write` lets an
agent patch property values; with shared ids it would silently also allow
rewriting the text of every page. Trade-off accepted: two more capabilities for
grants to manage.

| Operation | Capability | Approval |
|---|---|---|
| `page.get` | `core.page.read` | no |
| `page.changes` | `core.page.read` | no |
| `page.ensure` | `core.page.write` | no (idempotent, creates only an empty document) |
| `page.insert` | `core.page.write` | no (additive) |
| `page.createSubpage` | `core.page.write` | no (additive) |
| `page.duplicate` | `core.page.write` | no (creates a copy, changes no existing page) |
| `page.rename` | `core.page.write` | no (reversible) |
| `page.replace` | `core.page.write` | yes, `riskClass: "destructive"` |
| `page.restoreVersion` | `core.page.write` | yes, `riskClass: "destructive"` |

Replacing the whole page and restoring an older version both discard current
content, so they are destructive in the sense of the existing metadata. No
operation in the family deletes a page or a document; deleting stays
`item.delete`. This table is only the initial classification. Agent grants and
the page-write policy for Semp are decided in #1400 and #1844, which refine it
and record any contradiction in a new ADR.

### 4. Read semantics

`page.get` has no side effects and never creates a document. For an item
without a document it answers `docId: null`, an empty block list and zero
counts. Creation happens only through `page.ensure`, which is idempotent:
calling it on an item that already has a document returns that document
unchanged, and concurrent calls yield one document. Rejected: create on first
read, because a read that writes breaks the read-only capability, is invisible
to approval, and would create a document for every item a list view or an
agent merely looks at.

### 5. Summary shape

`page.get` with `format: summary` returns:

| Field | Meaning | Filled by |
|---|---|---|
| `docId` | document id or `null` | #1615 |
| `kind` | document kind (`page`) | #1615 |
| `title` | root page title (section 6) | #1615 |
| `blocks[]` | up to `limit` blocks: `id`, `type`, `indent`, `done`, `text`, `pageId` | #1615 (`pageId` of `page` blocks by #1676) |
| `blockCount` | total number of blocks | #1615 |
| `subpageCount` | number of `page` blocks | #1676 |
| `headings[]` | `h1`-`h3` blocks with id and text | #1615 |
| `lastEdited` | `{at, by}`, time and author of the latest update | #1615, where `doc_updates` records them |
| `breadcrumbs[]` | ancestor pages from the root | #1676, following where subpages live (#1393) |

`format: markdown` returns the Markdown serialization of #1678 instead of
`blocks`; the title is not part of it.

### 6. Title

The root page title is stored in a `Y.Map` named `meta` of the document under
the key `title` and is not part of the Markdown. A project's root page defaults
to the translated "Notes" title, which is not stored: the title stays empty and
the client or summary supplies the localized default. `page.rename` writes
`meta.title`.

### 7. Errors

401 without a session; 404 for an item of another tenant (indistinguishable
from a missing item); 400 for validation, including a block-model violation of
[[2026-10-28-block-model-for-page-documents]] in submitted content; 409 on
`page.replace` when `expectedLastEditedAt` is given and differs from the
document's current `lastEdited.at`. The implementing issue defines the exact
encoding of that comparison.

### 8. No native block JSON API; offline merge

No operation exposes a block JSON API for native clients: iOS and macOS edit
in a WebView with the shared JavaScript model, per the block-model ADR. The
family serves agents, MCP and server-side use through Markdown and summaries.
Offline edits from clients merge through `WS /api/sync` with Yjs state
vectors; the HTTP operations do not replace that channel. A write operation
applies its change to the server document as Yjs updates, so a concurrent
offline edit merges by Yjs rules. Only `page.replace` offers the optimistic 409
check.

## Consequences

- Each implementing issue registers one name in `operationNames.ts`, a binding,
  a metadata entry and tests; tests that assert the catalog size change by one
  per issue.
- The first implementing issue adds `core.page.read` and `core.page.write`;
  tests that assert the capability list change with it.
- Sub-resource paths under `/api/items/:id/page` are reserved for this family.
- Agent grants (#1400, #1844) have a fixed starting point and do not reopen the
  catalog-versus-routes question.
