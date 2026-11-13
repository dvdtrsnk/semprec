// The approval snapshot of an agent's `page.convertToBlock` (issue #1876), shaped like the page replace's
// (`pageReplaceApproval.ts`): the gateway asks for it when the agent calls the operation and again when the approved
// request is executed, and the two must agree. The conversion itself is `convertPageToBlockWithClient`.
// Constrained by: docs/adr/2026-09-18-exactly-once-execution-of-approved-destructive-operations.md
import type { PoolClient } from "pg";
import type { PageConvertToBlockInput } from "@semprec/shared";
import { buildResourceSnapshot, type DestructiveResourceProjection } from "../chokePoint/destructiveProjection.js";
import { planPageConvertToBlock } from "./pageOperations.js";

/** The approval-gated check of `page.convertToBlock`. */
export interface PageConvertCheck {
  operation: "page.convertToBlock";
  input: PageConvertToBlockInput;
  /** The agent's project: its `write` access to the database that owns the parent page is checked as the conversion checks it. */
  agentProjectItemId?: string;
}

/**
 * Authorizes and projects a `page.convertToBlock` without writing, by running the refusals of the conversion
 * (`planPageConvertToBlock`): the agent's project needs write access to the parent page's owner database, the block
 * has to be the page block of a live subpage of the parent, and `confirmedPageCount` has to be the current count of
 * pages the trash takes. A conversion that would be refused therefore creates no approval request, and an approved one
 * whose page tree changed since ends as a conflict. The snapshot holds the identity of the block and the page, the
 * target type and the page count; the description names the page by the title its page block shows in the parent's
 * document (normalized like a page title), the text the new block receives, not by the mirrored `title` of the Pages
 * item, which may lag, and holds no page content.
 */
export async function computePageConvertProjection(
  client: PoolClient,
  check: PageConvertCheck,
): Promise<DestructiveResourceProjection> {
  const plan = await planPageConvertToBlock(client, check.input, check.agentProjectItemId);
  const projected = {
    parentItemId: plan.parent.id,
    blockId: check.input.blockId,
    pageItemId: plan.page.id,
    type: check.input.type,
    pageCount: plan.trashedPageCount,
  };
  return {
    snapshot: buildResourceSnapshot("page_convert", plan.page.id, projected),
    currentResource: {
      ...projected,
      approvalDescription: {
        key: "approval.pageConvertToBlock",
        params: { pageName: plan.title, blockType: check.input.type, pageCount: plan.trashedPageCount },
      },
    },
  };
}
