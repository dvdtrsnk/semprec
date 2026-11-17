// Approval snapshot of an agent's `page.replace`; computed at call time and again at execution, and the two must agree.
import type { PoolClient } from "pg";
import { buildResourceSnapshot, type DestructiveResourceProjection } from "../chokePoint/destructiveProjection.js";
import { checkPageReplace } from "./pageMarkdown.js";
import { assertAgentPageAccess } from "./pageOwnerDatabase.js";

export interface PageReplaceCheck {
  operation: "page.replace";
  input: { itemId: string; markdown: string; expectedEtag: string };
  agentProjectItemId?: string;
}

/**
 * Rehearses the replace's refusals without writing, so a refused replace creates no approval request and an approved
 * one whose page changed ends as a conflict. The snapshot excludes the Markdown, which the request payload keeps.
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
