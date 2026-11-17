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
 * Reads only the Processing proposals database id of the config, so split siblings can use it as the tick does. Kept
 * out of `inboxTickAction.ts`, which sits at the ESLint `max-lines` cap.
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
