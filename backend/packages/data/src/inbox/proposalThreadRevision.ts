import type { PoolClient } from "pg";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import type { ItemRow } from "../types.js";
import { isFinalInvalid } from "./inboxTickAction.js";
import { LOCKED_PROPOSAL_STATUSES } from "./inboxTypesStore.js";
import { enqueueJournalInboxRecomputeForProposal } from "./journalInboxCompute.js";
import {
  appendRevisionEntry,
  assertValidEnvelopeForCard,
  lockLiveProposal,
  unsupportedEntityKindError,
  type ProposalActionConfig,
} from "./proposalActions.js";
import { aiProposalPatch, readAiProposal, type ProposalEntityKind, type ProposalEnvelope } from "./proposalEnvelope.js";
import { referencedItemIdsOf } from "./proposalReferences.js";
import { appendDroppedValuesEntry } from "./proposalRetention.js";
import { composeEffectiveEnvelope, parseUserOverrides, retainOverridesForThreadRevision } from "./proposalOverrides.js";

/**
 * A revision of a Processing proposal made in an Inbox item thread (issue #1938), split out of `proposalActions.ts` to
 * keep that file under the ESLint line cap; `proposalActions.ts` re-exports `reviseProposalFromThreadWithClient`
 * and `ReviseProposalFromThreadInput`. The helpers this module takes from `proposalActions.ts` are used only inside
 * functions, so the import cycle does not matter at module load.
 */

export interface ReviseProposalFromThreadInput {
  proposalId: string;
  /** The Inbox item the thread is about; only a card whose source is this item is revised. */
  subjectItemId: string;
  /** The thread and the assistant message of the turn that makes the revision, recorded in the card's history. */
  threadId: string;
  messageId: string;
  /** Each defaults to that of the card's current assistant proposal. A card that has none needs both. */
  entityKind?: ProposalEntityKind;
  target?: string;
  /** The revised envelope's properties: all of them, as the assistant read them from the effective envelope. */
  properties: Record<string, unknown>;
  message?: string;
  /**
   * The card's `updatedAt` as the assistant read it when it composed the revised envelope. A card that was changed
   * since, by the user's edit or by the tick, is refused with a `ConflictError`, so a revised envelope built from a
   * stale card never overwrites a newer manual value. The `inbox.proposal.revise` tool requires it.
   */
  ifVersion?: string;
  /** The user the thread belongs to; addresses the realtime invalidation of the write. */
  actingUserId?: string;
}

/**
 * Throws the `NotFoundError` of a missing proposal unless `subjectItemId` is the source Inbox item of the card:
 * the two are joined by a `sourceInbox` edge. The edge is read `FOR SHARE`, so a removal of it that is still open
 * is waited for and one that committed is seen; the answer is the same for a card of another item as for a card
 * that does not exist. `splitInboxSourceWithClient` (issue #1939) makes the same check.
 */
export async function assertCardOfSubject(
  client: PoolClient,
  config: ProposalActionConfig,
  card: ItemRow,
  subjectItemId: string,
): Promise<void> {
  const property = await propertiesStore.getPropertyByKey(client, config.processingProposalsDatabaseId, "sourceInbox");
  const definition = property ? await relationsStore.getRelationDefinitionByPropertyId(client, property.id) : null;
  const edges = definition
    ? await client.query<{ id: string }>(
        `SELECT id FROM item_relations
          WHERE relation_definition_id = $1 AND ((item_a = $2 AND item_b = $3) OR (item_a = $3 AND item_b = $2))
            FOR SHARE`,
        [definition.id, card.id, subjectItemId],
      )
    : { rows: [] };
  if (edges.rows.length === 0) throw new NotFoundError(`Processing proposal ${card.id} not found`);
}

/**
 * Revises a card from its Inbox item thread (issue #1938), in the caller's transaction and under the card's row lock.
 * The assistant passes the whole revised envelope (`kind`, `target` and `properties`), which it composed from the
 * effective envelope, so it holds the user's manual values unless the instruction changed them. The card is stored as
 * `retainOverridesForThreadRevision` decides: a manual key keeps its previous assistant value in `aiProposal` and takes
 * the revised value as the user's value, so a key the instruction left alone stays protected and one it changed stays
 * in `userEditedKeys`; every other key is written to `aiProposal`; a change of `entityKind` or `target` drops every
 * manual value. `proposal` holds the effective envelope, which is the revised envelope, validated as confirm validates
 * it (`assertValidEnvelopeForCard`: the credential guard of an MCP server, relation checks, the target's rules). The
 * status becomes `proposed`, a fixable `invalid` card leaves `invalid`, `aiVersion` is incremented, and the history
 * gains an entry of author `ai`, kind `threadRevision`, the thread and the message, followed by a `reset` entry when a
 * manual value was dropped. Nothing is written to a target database.
 *
 * Refused with the `NotFoundError` of a missing card when the card's source is not `subjectItemId`; with a
 * `ValidationError` when the card is `confirmed` or `rejected` or its source Inbox item was deleted, when the envelope
 * is invalid, and when `entityKind` or `target` is absent for a card that has no assistant proposal; with a
 * `ConflictError` for a stored kind this release does not support, and with the `ConflictError` of a changed card when
 * `ifVersion` is not the card's current `updatedAt` (checked after the card is known to be the subject's and open, so
 * it reveals nothing about another item's card). A refused call writes nothing.
 */
export async function reviseProposalFromThreadWithClient(
  client: PoolClient,
  config: ProposalActionConfig,
  input: ReviseProposalFromThreadInput,
): Promise<ItemRow> {
  const proposal = await lockLiveProposal(client, config.processingProposalsDatabaseId, input.proposalId);
  await assertCardOfSubject(client, config, proposal, input.subjectItemId);
  const status = proposal.properties.status;
  if (typeof status === "string" && LOCKED_PROPOSAL_STATUSES.has(status)) {
    throw new ValidationError(`Cannot revise a locked proposal (status '${status}')`, { field: "status" });
  }
  if (isFinalInvalid(proposal.properties)) {
    throw new ValidationError("Cannot revise a proposal whose source Inbox item was deleted", { field: "status" });
  }
  if (input.ifVersion !== undefined && input.ifVersion !== proposal.updatedAt) {
    throw new ConflictError(
      "The card was changed after you read it. Read it again with inbox.proposal.get and compose the revision from its current envelope.",
      { field: "ifVersion" },
    );
  }

  const previous = readAiProposal(proposal.properties, proposal.id);
  if (previous && "unknownKind" in previous) throw unsupportedEntityKindError(previous.entityKind);
  const entityKind = input.entityKind ?? previous?.entityKind;
  const target = input.target ?? previous?.target;
  if (entityKind === undefined || target === undefined) {
    throw new ValidationError("'entityKind' and 'target' are required for a card that has no proposal yet", {
      field: entityKind === undefined ? "entityKind" : "target",
    });
  }
  const revised: ProposalEnvelope = { entityKind, target, properties: input.properties };

  const retained = retainOverridesForThreadRevision(
    previous,
    revised,
    parseUserOverrides(proposal.properties.userOverrides, proposal.id),
  );
  const effective = composeEffectiveEnvelope(retained.aiProposal, retained.userOverrides);
  await assertValidEnvelopeForCard(client, config, proposal, effective);
  const history = appendDroppedValuesEntry(
    appendRevisionEntry(proposal.properties.history, input.message, {
      author: "ai",
      threadId: input.threadId,
      messageId: input.messageId,
    }),
    retained,
  );

  const updated = await updateItemWithClient(
    client,
    {
      databaseId: config.processingProposalsDatabaseId,
      itemId: proposal.id,
      propertiesPatch: {
        proposal: effective,
        referencedItemIds: referencedItemIdsOf(effective),
        ...aiProposalPatch(proposal.properties, retained.aiProposal),
        userOverrides: retained.userOverrides,
        userEditedKeys: retained.userEditedKeys,
        status: "proposed",
        // A fixable invalid card leaves `invalid` here, so its reason goes with it in this same write.
        ...(status === "invalid" ? { invalidReason: null } : {}),
        history,
      },
    },
    {
      allowedSystemKeys: [
        "proposal",
        "aiProposal",
        "aiVersion",
        "referencedItemIds",
        "userOverrides",
        "userEditedKeys",
        "status",
        "invalidReason",
        "history",
      ],
      actingUserId: input.actingUserId,
    },
  );
  await enqueueJournalInboxRecomputeForProposal(client, proposal.id);
  return updated;
}
