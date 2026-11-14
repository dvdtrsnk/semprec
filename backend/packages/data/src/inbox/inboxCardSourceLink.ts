import type { PoolClient } from "pg";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import type { SystemRelationWriteContext } from "../chokePoint/relationEdgeContext.js";
import { PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import type { SemprecTickActionConfig } from "./proposalEnvelope.js";

const PROCESSING_PROPOSALS_RELATION_CONTEXT: SystemRelationWriteContext = {
  ownerProcess: PROCESSING_PROPOSALS_MODULE_ID,
};

/**
 * Links a freshly created Processing proposal back to its source Inbox item via `sourceInbox`. It reads only the
 * Processing proposals database id of the config, so the sibling cards of a split (issue #1939) use it as the tick does.
 * Lives apart from `inboxTickAction.ts`, which sits at the ESLint `max-lines` cap (issue #1811 moved
 * it unchanged to make room for the card realtime calls).
 */
export async function linkSourceInboxRelation(
  client: PoolClient,
  config: Pick<SemprecTickActionConfig, "processingProposalsDatabaseId">,
  proposalId: string,
  sourceItemId: string,
): Promise<void> {
  const sourceInboxProperty = await propertiesStore.getPropertyByKey(
    client,
    config.processingProposalsDatabaseId,
    "sourceInbox",
  );
  if (!sourceInboxProperty)
    throw new Error(
      `Processing proposals database ${config.processingProposalsDatabaseId} has no 'sourceInbox' relation property`,
    );
  await createRelationWithClient(
    client,
    { relationPropertyId: sourceInboxProperty.id, callerItemId: proposalId, targetItemId: sourceItemId },
    PROCESSING_PROPOSALS_RELATION_CONTEXT,
  );
}
