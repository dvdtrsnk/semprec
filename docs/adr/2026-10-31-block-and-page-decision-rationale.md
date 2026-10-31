---
status: accepted
date: 2026-10-31
area: [backend]
supersedes: []
superseded-by: null
---

# Record backend trade-offs for page and block decisions

## Context

[[2026-10-28-block-model-for-page-documents]] and
[[2026-10-28-page-operation-family]] set the block and page contracts. This
record states present rationale without claiming what the historical authors
considered. It preserves their bodies and contracts. Earlier alternatives remain
in those records.

## Decision

The closed block type registry rejects an open set of flavours; the accepted
trade-off is reduced extensibility until the registry is deliberately changed.
The `Y.Text` inline model rejects whole JSON or Markdown strings; its accepted
trade-off is the additional shared rich-text model dependency for consumers.

A side-effect-free `page.get` and idempotent `page.ensure` reject creating a
document on read. The accepted trade-off is a separate creation operation when
a document is needed.

For existing documents, reject a migration sweep in favor of read-time
normalization: a sweep would add a dedicated write and rollout path for data
the original decision says was not present in production. The trade-off is
that legacy state remains stored and every reader must normalize it.

For native clients, reject a separate JSON block API in favor of the existing
shared Yjs model. A second editing representation needs another conversion and
consistency contract; the trade-off is reliance on the shared JavaScript editor.

For concurrent edits, reject server-serialized whole-document replacement in
favor of Yjs merge and deterministic read-time normalization. Serialization
would prevent useful offline concurrent editing and discard or reject a stale
writer; the trade-off is that concurrent moves can merge to an order neither
writer intended while replicas still converge.

For page summaries, reject returning only Markdown: clients and agents would
have to parse it again for block metadata, headings and counts. The trade-off
is maintaining an explicit summary contract as those fields are implemented.

For the page title, reject embedding it in Markdown content: the title is
metadata and must be addressable separately. The trade-off is that exporting
Markdown alone does not contain the title.

For errors, reject collapsing validation, missing item and version conflict
into one response: consumers could not distinguish corrections from retryable
conflicts. The trade-off is maintaining distinct error cases, while a foreign
item remains indistinguishable from a missing item.

For offline edits, reject replacing the Yjs synchronization path with HTTP
whole-page replacement: a stale offline write would overwrite concurrent work
or need rejection. The trade-off is relying on Yjs merge semantics and their
accepted limitations. The optimistic version check remains specific to
`page.replace` as recorded in the page operation decision.

The existing backend workspace includes `../shared/block-model`, and the data
package consumes `@semprec/block-model` via `workspace:*`. This updates the
earlier `link:`/`file:` consumption choice without moving the shared package
inside `backend/`. Reject a separate `link:`/`file:` dependency outside the
backend workspace: workspace inclusion allows one backend installation and
lockfile to resolve the shared package consistently. The trade-off is that the
backend workspace now includes a directory outside its own tree. Web and
mobile packaging remain deferred; this does not join their workspaces or
reorganize any lockfile.

## Consequences

The existing page and block choices and their future implementation issue
boundaries remain unchanged. This record is rationale for those decisions, not
evidence that their future operations already run.
