import type { PoolClient } from "pg";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { NotFoundError, ProposalLockedError, ValidationError } from "../errors.js";
import { triggerOnItemEventHeartbeats } from "../scheduler/schedulerStore.js";
import type { ItemRow } from "../types.js";
import { publishInboxCardChange } from "./inboxCardsRealtime.js";
import { isComputingTimedOut } from "./inboxCardsStore.js";
import { appendHistoryEntry, isFinalInvalid } from "./inboxTickAction.js";
import { LOCKED_PROPOSAL_STATUSES } from "./inboxTypesStore.js";
import { lockLiveProposal, type ProposalActionConfig } from "./proposalActions.js";
import { assertProposalVersion } from "./proposalPreconditions.js";

// The user's request to recompute an Inbox card; re-exported from `proposalActions.ts`. `lockLiveProposal` is used
// only inside a function, so the import cycle is harmless at module load.

/** Names no field, because a card's values are user content. */
const RECOMPUTE_MESSAGE = "The user asked for a new proposal; the proposal is being recomputed.";

export interface RecomputeProposalInput {
  /** A value other than the card's current `updatedAt` refuses the recompute with a `ConflictError`. */
  ifVersion?: string;
  actingUserId?: string;
}

/** The live source Inbox item via `sourceInbox`, read without a lock; `null` when absent or trashed. */
async function readLiveSource(
  client: PoolClient,
  config: ProposalActionConfig,
  proposalId: string,
): Promise<ItemRow | null> {
  const property = await propertiesStore.getPropertyByKey(client, config.processingProposalsDatabaseId, "sourceInbox");
  const definition = property && (await relationsStore.getRelationDefinitionByPropertyId(client, property.id));
  if (!definition) {
    throw new NotFoundError(
      `Processing proposals database ${config.processingProposalsDatabaseId} has no 'sourceInbox' relation`,
    );
  }
  const edges = await relationsStore.listRelationsForItem(client, definition.id, proposalId);
  const [source] = await itemsStore.getItemsByIds(
    client,
    edges.map((edge) => relationsStore.otherSide(edge, proposalId)),
  );
  return source ?? null;
}

/**
 * `POST /api/proposals/:id/recompute`: sends an Inbox card back to the tick without touching the source, writing
 * `computing` and a `recompute` entry under the card's row lock and triggering the source's `update` heartbeats.
 * Values and overrides stay. An already `computing` card is returned unchanged before the `ifVersion` check, unless
 * past `COMPUTING_TIMEOUT_MS` (then this is its retry).
 *
 * The card is locked first and the source is not locked (read only to name it), like the other card actions. The
 * tick and the type change take the source first but reserve the card without waiting, so neither waits for this
 * transaction while holding the source.
 */
export async function recomputeProposalWithClient(
  client: PoolClient,
  config: ProposalActionConfig,
  proposalId: string,
  input: RecomputeProposalInput,
): Promise<ItemRow> {
  const proposal = await lockLiveProposal(client, config.processingProposalsDatabaseId, proposalId);
  if (proposal.properties.kind !== "inbox") {
    throw new ValidationError("Only a card of an Inbox item can be recomputed", { field: "kind" });
  }
  const status = proposal.properties.status;
  if (typeof status === "string" && LOCKED_PROPOSAL_STATUSES.has(status)) throw new ProposalLockedError();
  if (isFinalInvalid(proposal.properties)) {
    throw new ValidationError("Cannot recompute a proposal whose source Inbox item was deleted", { field: "status" });
  }
  if (status === "computing" && !isComputingTimedOut(proposal, new Date())) return proposal;
  assertProposalVersion(proposal, input.ifVersion);

  const source = await readLiveSource(client, config, proposal.id);
  if (!source) throw new NotFoundError(`Source Inbox item of proposal ${proposal.id} not found`);

  const updated = await updateItemWithClient(
    client,
    {
      databaseId: config.processingProposalsDatabaseId,
      itemId: proposal.id,
      propertiesPatch: {
        status: "computing",
        history: appendHistoryEntry(proposal.properties.history, RECOMPUTE_MESSAGE, "user", { kind: "recompute" }),
        ...(status === "invalid" ? { invalidReason: null } : {}),
      },
    },
    {
      allowedSystemKeys: ["status", "history", ...(status === "invalid" ? ["invalidReason"] : [])],
      actingUserId: input.actingUserId,
    },
  );
  publishInboxCardChange(client, proposal.id, "updated");
  await triggerOnItemEventHeartbeats(client, source.databaseId, "update", source.id);
  return updated;
}
