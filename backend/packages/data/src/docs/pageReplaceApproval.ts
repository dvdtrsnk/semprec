// The approval snapshot of an agent's `page.replace` (issue #1844), shaped like the choke point's own destructive checks
// and like the restore's (`docPageRestore.ts`): the gateway asks for it when the agent calls the operation and again when
// the approved request is executed, and the two must agree. The replace itself is `replacePageMarkdown`.
// Constrained by: docs/adr/2026-10-29-agent-page-write-policy.md, docs/adr/2026-11-12-page-replace-takes-the-etag-and-trashes-vanished-subpages.md
import type { PoolClient } from "pg";
import { buildResourceSnapshot, type DestructiveResourceProjection } from "../chokePoint/destructiveProjection.js";
import { checkPageReplace } from "./pageMarkdown.js";
import { assertAgentPageAccess } from "./pageOwnerDatabase.js";

/** The approval-gated check of `page.replace`. */
export interface PageReplaceCheck {
  operation: "page.replace";
  input: { itemId: string; markdown: string; expectedEtag: string };
  /** The agent's project: its `write` access to the database that owns the page is checked as `replacePageMarkdown` does. */
  agentProjectItemId?: string;
}

/**
 * Authorizes and projects a `page.replace` without writing: the agent's project needs write access to the page's
 * owner database, then the replace's own refusals are rehearsed (`checkPageReplace`: a live item, valid Markdown and
 * links, and an `expectedEtag` equal to the page's current version), so a replace that would be refused creates no
 * approval request and an approved one whose page changed since ends as a conflict. The snapshot holds the page's
 * identity and the version token it was approved against; it does not hold the Markdown, which the request payload keeps.
 */
export async function computePageReplaceProjection(
  client: PoolClient,
  check: PageReplaceCheck,
): Promise<DestructiveResourceProjection> {
  await assertAgentPageAccess(client, check.agentProjectItemId, check.input.itemId, "write");
  const { docId, etag } = await checkPageReplace(
    client,
    check.input.itemId,
    check.input.markdown,
    check.input.expectedEtag,
  );
  const projected = { itemId: check.input.itemId, docId, etag };
  return { snapshot: buildResourceSnapshot("page_replace", check.input.itemId, projected), currentResource: projected };
}
