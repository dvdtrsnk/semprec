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

/**
 * The user's request for a new computation of an Inbox card (issue gh-1955), split out of `proposalActions.ts` to keep
 * that file under the ESLint line cap; `proposalActions.ts` re-exports `recomputeProposalWithClient` and
 * `RecomputeProposalInput`, so callers import them from there. The shared helper this module takes from
 * `proposalActions.ts` (`lockLiveProposal`) is used only inside a function, so the import cycle does not matter at
 * module load.
 */

/** The history message of the request; it names no field, because a card's values are user content. */
const RECOMPUTE_MESSAGE = "The user asked for a new proposal; the proposal is being recomputed.";

export interface RecomputeProposalInput {
  /** The card's `updatedAt` as the client read it; a different current value refuses the recompute with a `ConflictError`. */
  ifVersion?: string;
  /** Addresses the realtime invalidation of the write. */
  actingUserId?: string;
}

/** The live Inbox item the card's `sourceInbox` edge leads to, read without a lock; `null` when the card has no edge or the item is gone or trashed. */
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
 * `POST /api/proposals/:id/recompute` (issue gh-1955): sends a card of an Inbox item back to the tick for a new
 * computation, without touching the source. In the caller's transaction, under the card's row lock, it writes the status
 * `computing` and a `recompute` history entry of the user, and triggers the `update` heartbeats of the source's Inbox
 * database for the source item, which queues the tick. The tick then stores the new proposal and leaves `computing`
 * (`docs/adr/2026-11-14-a-computing-card-is-recomputed-by-the-tick-regardless-of-its-fingerprint.md`). `proposal`,
 * `aiProposal`, `userOverrides` and `userEditedKeys` stay as they were; the tick keeps the manual values over the new
 * proposal. An `invalidReason` goes with a status of `invalid`.
 *
 * - A card whose `kind` is not `inbox` is a `ValidationError` on `kind`; a transcript card is recomputed from an
 *   instruction of the user by its own route.
 * - A `confirmed` or `rejected` card is a `ProposalLockedError` (409 `proposal_locked`), and an `invalid` card whose
 *   source Inbox item was deleted (`sourceDeleted`) a `ValidationError`. Every other status is accepted.
 * - A card that is `computing` already is returned unchanged: nothing is written and no job is queued. This answer comes
 *   before the `ifVersion` check, as the `rejected` answer of the reject action does. A card that has been `computing`
 *   past `COMPUTING_TIMEOUT_MS` (`isComputingTimedOut`, issue gh-2026) is not answered so: the card list shows it as
 *   failed, and this is its retry, so it is accepted like any other status. It is written as `computing` again, which
 *   gives it a new `updatedAt`, and the tick is triggered.
 * - An `ifVersion` that is not the card's `updatedAt` is a `ConflictError` carrying the card, and nothing is written.
 * - A card whose source Inbox item is missing or trashed is a `NotFoundError`. The source is read without a lock, only
 *   to name the item and the database the tick is triggered for.
 *
 * The card is locked first and the source is not locked, like the other card actions that start from the card
 * (`reviseProposalWithClient`); the tick and the type change take the source first but reserve the card without waiting,
 * so neither waits for this transaction while holding the source.
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
