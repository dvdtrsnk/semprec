// Approval snapshot of an agent's `page.convertToBlock`; computed at call time and again at execution, and the two
// must agree.
import type { PoolClient } from "pg";
import type { PageConvertToBlockInput } from "@semprec/shared";
import { buildResourceSnapshot, type DestructiveResourceProjection } from "../chokePoint/destructiveProjection.js";
import { planPageConvertToBlock } from "./pageOperations.js";

export interface PageConvertCheck {
  operation: "page.convertToBlock";
  input: PageConvertToBlockInput;
  agentProjectItemId?: string;
}

/**
 * Runs the conversion's own refusals without writing, so a refused conversion creates no approval request and an
 * approved one whose tree changed ends as a conflict. The description uses the block's title, not the lagging
 * mirrored item `title`, and holds no page content.
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
