import type { PoolClient } from "pg";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/chokePoint.js";
import { putBlockWithClient } from "../docs/docStore.js";
import { LOCKED_PROPOSAL_STATUSES } from "./inboxTypesStore.js";
import { appendHistoryEntry, assertValidProposalEnvelope, type ProposalEntityKind, type ProposalEnvelope } from "./inboxTickAction.js";
import { NotFoundError, ValidationError } from "../errors.js";
import type { ItemRow } from "../types.js";

export interface ProposalActionConfig {
  processingProposalsDatabaseId: string;
}

/** Row-locks the proposal (serializing concurrent confirm/reject/revise on the same row) and rejects a missing or soft-deleted one. */
async function lockLiveProposal(client: PoolClient, databaseId: string, proposalId: string): Promise<ItemRow> {
  const proposal = await itemsStore.lockItemById(client, databaseId, proposalId);
  if (!proposal || proposal.deletedAt) throw new NotFoundError(`Processing proposal ${proposalId} not found`);
  return proposal;
}

/** The target item's own title-property value, for `resultLabel` — falls back to the item id when the target database declares no title property or the value is empty. */
async function resolveResultLabel(client: PoolClient, databaseId: string, item: ItemRow): Promise<string> {
  const properties = await propertiesStore.listPropertiesByDatabase(client, databaseId);
  const titleProperty = properties.find((property) => property.type === "title");
  const value = titleProperty ? item.properties[titleProperty.key] : undefined;
  return typeof value === "string" && value.length > 0 ? value : item.id;
}

/**
 * `POST /api/proposals/:id/confirm` (issue #105): the sole cross-destination write path —
 * an agent proposes via `processingProposals`, only a user-context confirm may ever create
 * or amend a target database item or page block. Idempotent under retry: an
 * already-`confirmed` proposal is returned as-is rather than re-executing the destination
 * write (which would otherwise double-create a `database` item, or duplicate wall-clock
 * history entries on a `pageContent` block).
 *
 * `envelope.target` is re-validated against current destination state (issue #104's
 * `assertValidProposalEnvelope`) rather than trusting whatever passed validation when the
 * proposal was computed — the target database/page could have been deleted or had its
 * schema changed since.
 *
 * For `pageContent`, the appended block's `id` is the proposal's own id, not a freshly
 * generated one: `putBlockWithClient`'s block upsert is itself idempotent on a given id, so
 * a confirm retried after a crash between the block write and the `confirmed` lock below
 * (both in the same transaction here, but a caller retrying after an earlier failed attempt
 * could still see this ordering) overwrites the same block rather than leaving an orphaned
 * duplicate.
 */
export async function confirmProposalWithClient(client: PoolClient, config: ProposalActionConfig, proposalId: string): Promise<ItemRow> {
  const proposal = await lockLiveProposal(client, config.processingProposalsDatabaseId, proposalId);
  const status = proposal.properties.status;
  if (status === "confirmed") return proposal;
  if (status !== "proposed") {
    throw new ValidationError(`Cannot confirm a proposal in status '${String(status)}'`, { field: "status" });
  }

  const envelope = proposal.properties.proposal as ProposalEnvelope | null;
  if (!envelope) throw new ValidationError("Proposal has no computed envelope to confirm", { field: "proposal" });
  await assertValidProposalEnvelope(client, envelope);

  let resultItemId: string;
  let resultLabel: string;
  if (envelope.entityKind === "database") {
    const created = await createItemWithClient(client, { databaseId: envelope.target, properties: envelope.properties });
    resultItemId = created.id;
    resultLabel = await resolveResultLabel(client, envelope.target, created);
  } else {
    // Safe to cast without a further runtime check here: `assertValidProposalEnvelope`
    // above already rejects a 'pageContent' envelope whose `flavour` isn't a non-empty
    // string, or whose `fields`/`children` (if present) aren't a plain object / string
    // array respectively.
    const { flavour, fields, children } = envelope.properties as { flavour: string; fields?: Record<string, unknown>; children?: string[] };
    await putBlockWithClient(client, envelope.target, { id: proposal.id, flavour, fields, children }, "ai_agent");
    const [targetPage] = await itemsStore.getItemsByIds(client, [envelope.target]);
    resultItemId = envelope.target;
    resultLabel = targetPage ? await resolveResultLabel(client, targetPage.databaseId, targetPage) : envelope.target;
  }

  return updateItemWithClient(
    client,
    {
      databaseId: config.processingProposalsDatabaseId,
      itemId: proposal.id,
      propertiesPatch: {
        status: "confirmed",
        resultItemId,
        resultLabel,
        history: appendHistoryEntry(proposal.properties.history, "Confirmed by user.", "user"),
      },
    },
    { allowedSystemKeys: ["status", "resultItemId", "resultLabel", "history"] },
  );
}

/**
 * `POST /api/proposals/:id/reject` (issue #105): locks the proposal as `rejected` without
 * ever writing a destination. Idempotent under retry (an already-`rejected` proposal is
 * returned as-is); rejecting a `confirmed` proposal is refused, since its destination write
 * already happened and rejecting now could not undo it.
 */
export async function rejectProposalWithClient(client: PoolClient, config: ProposalActionConfig, proposalId: string, message?: string): Promise<ItemRow> {
  const proposal = await lockLiveProposal(client, config.processingProposalsDatabaseId, proposalId);
  const status = proposal.properties.status;
  if (status === "rejected") return proposal;
  if (status === "confirmed") {
    throw new ValidationError("Cannot reject a proposal that has already been confirmed", { field: "status" });
  }

  return updateItemWithClient(
    client,
    {
      databaseId: config.processingProposalsDatabaseId,
      itemId: proposal.id,
      propertiesPatch: {
        status: "rejected",
        history: appendHistoryEntry(proposal.properties.history, message ?? "Rejected by user.", "user"),
      },
    },
    { allowedSystemKeys: ["status", "history"] },
  );
}

export interface ReviseProposalInput {
  message: string;
  entityKind: ProposalEntityKind;
  target: string;
  properties: Record<string, unknown>;
}

/**
 * `POST /api/proposals/:id/revise` (issue #105): a chat-driven correction. Always replaces
 * the complete envelope — including `entityKind`, so a revise can switch a proposal from
 * `database` to `pageContent` or vice versa atomically — never a partial patch onto the
 * existing one, since a partial merge of `target`/`properties` across different
 * `entityKind`s would produce a nonsensical envelope. Refused on a locked (`confirmed`/
 * `rejected`) proposal, per the epic's "a locked card is never recomputed again"; allowed
 * from `needsClarification`/`invalid` as well as `proposed`, since a user resolving one of
 * those into a valid envelope is exactly how a proposal is meant to leave that state.
 */
export async function reviseProposalWithClient(client: PoolClient, config: ProposalActionConfig, proposalId: string, input: ReviseProposalInput): Promise<ItemRow> {
  const proposal = await lockLiveProposal(client, config.processingProposalsDatabaseId, proposalId);
  const status = proposal.properties.status;
  if (typeof status === "string" && LOCKED_PROPOSAL_STATUSES.has(status)) {
    throw new ValidationError(`Cannot revise a locked proposal (status '${status}')`, { field: "status" });
  }

  const envelope: ProposalEnvelope = { entityKind: input.entityKind, target: input.target, properties: input.properties };
  await assertValidProposalEnvelope(client, envelope);

  return updateItemWithClient(
    client,
    {
      databaseId: config.processingProposalsDatabaseId,
      itemId: proposal.id,
      propertiesPatch: {
        proposal: envelope,
        status: "proposed",
        history: appendHistoryEntry(proposal.properties.history, input.message, "user"),
      },
    },
    { allowedSystemKeys: ["proposal", "status", "history"] },
  );
}
