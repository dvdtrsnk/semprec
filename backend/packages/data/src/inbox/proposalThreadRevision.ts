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
import { aiProposalPatch, readAiProposal, type ProposalEntityKind } from "./proposalEnvelope.js";
import { carryNewOptions } from "./proposalNewOptions.js";
import { carryPageSections } from "./proposalPageSections.js";
import { referencedItemIdsOf } from "./proposalReferences.js";
import { appendDroppedValuesEntry } from "./proposalRetention.js";
import { composeEffectiveEnvelope, parseUserOverrides, retainOverridesForThreadRevision } from "./proposalOverrides.js";

// A revision of a proposal made in an Inbox item thread; re-exported from `proposalActions.ts`. Helpers taken from
// `proposalActions.ts` are used only inside functions, so the import cycle is harmless at module load.

export interface ReviseProposalFromThreadInput {
  proposalId: string;
  /** Only a card whose source is this item is revised. */
  subjectItemId: string;
  /** Recorded in the card's history. */
  threadId: string;
  messageId: string;
  /** Each defaults to the card's current assistant proposal; a card without one needs both. */
  entityKind?: ProposalEntityKind;
  target?: string;
  /** All of the revised envelope's properties, as the assistant read them from the effective envelope. */
  properties: Record<string, unknown>;
  message?: string;
  /**
   * The `updatedAt` the assistant composed from. A card changed since (user edit or tick) is refused with a
   * `ConflictError`, so a stale envelope never overwrites a newer manual value.
   */
  ifVersion?: string;
  /** Addresses the realtime invalidation of the write. */
  actingUserId?: string;
}

/**
 * Throws the missing-proposal `NotFoundError` unless `subjectItemId` is the card's source via `sourceInbox`. The edge
 * is read `FOR SHARE`, so an open removal is waited for and a committed one is seen.
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
 * Revises a card from its Inbox item thread under its row lock, from the whole envelope the assistant composed.
 * Overrides follow `retainOverridesForThreadRevision`; `proposal` is validated as confirm validates it. The history
 * gains a `threadRevision` entry. `ifVersion` is checked after the subject check, so it reveals nothing about another
 * item's card. A refused call writes nothing.
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
  if (input.ifVersion !== undefined && input.ifVersion !== proposal.version) {
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
  // The assistant composes properties alone, so the card's page sections and still-named new options are carried over.
  const revised = carryNewOptions(
    previous,
    carryPageSections(previous, { entityKind, target, properties: input.properties }),
  );

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
