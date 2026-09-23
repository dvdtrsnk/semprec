import type { PoolClient } from "pg";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import {
  assertRelationCreatableWithClient,
  createItemWithClient,
  createRelationWithClient,
  updateItemWithClient,
} from "../chokePoint/chokePoint.js";
import { putBlockWithClient } from "../docs/docStore.js";
import { LOCKED_PROPOSAL_STATUSES } from "./inboxTypesStore.js";
import {
  appendHistoryEntry,
  assertValidProposalEnvelope,
  type ProposalEntityKind,
  type ProposalEnvelope,
} from "./inboxTickAction.js";
import { enqueueJournalInboxRecomputeForProposal } from "./journalInboxCompute.js";
import { MCP_SERVERS_MODULE_ID } from "../seed/mcpModuleKeys.js";
import { EVENTS_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { storeCredential, type CredentialType } from "../credentials/externalCredentialsStore.js";
import { NotFoundError, ValidationError } from "../errors.js";
import type { ItemRow } from "../types.js";

export interface ProposalActionConfig {
  processingProposalsDatabaseId: string;
}

/**
 * A logged-in human's separately-supplied secret for an MCP server proposal (issue #123) —
 * never part of the envelope's `properties`, and only ever accepted by `confirmProposalWithClient`
 * itself, never `revise` (a chat-driven, AI-visible correction). Optional: not every MCP server
 * needs a credential (e.g. a local `stdio` command with no auth of its own).
 */
export interface ConfirmProposalCredentialInput {
  credentialType: CredentialType;
  plaintext: string;
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

/** The Transcripts `event` relation property: the Transcription<->Event edge a transcript card's confirm writes. */
const TRANSCRIPT_EVENT_PROPERTY_KEY = "event";

/** What a `kind = 'transcript'` card's confirm links: its source transcript, through the Transcripts `event` property. */
interface TranscriptEventEdge {
  transcriptId: string;
  eventPropertyId: string;
}

async function requireDatabaseIdByModuleId(client: PoolClient, moduleId: string): Promise<string> {
  const database = await databasesStore.getDatabaseByModuleId(client, moduleId);
  if (!database) throw new NotFoundError(`Database for module '${moduleId}' not found`);
  return database.id;
}

async function requireRelationPropertyId(client: PoolClient, databaseId: string, key: string): Promise<string> {
  const property = await propertiesStore.getPropertyByKey(client, databaseId, key);
  if (!property) throw new NotFoundError(`Property '${key}' not found on database ${databaseId}`);
  return property.id;
}

/** The transcript a `kind = 'transcript'` card was created for, via its `sourceTranscript` edge (written with the card by the match step). */
async function requireSourceTranscriptId(
  client: PoolClient,
  config: ProposalActionConfig,
  proposal: ItemRow,
): Promise<string> {
  const propertyId = await requireRelationPropertyId(client, config.processingProposalsDatabaseId, "sourceTranscript");
  const relationDefinition = await relationsStore.getRelationDefinitionByPropertyId(client, propertyId);
  if (!relationDefinition)
    throw new NotFoundError(`Relation definition for Processing proposals 'sourceTranscript' not found`);
  const [edge] = await relationsStore.listRelationsForItem(client, relationDefinition.id, proposal.id);
  if (!edge) {
    throw new ValidationError(`Transcript proposal ${proposal.id} has no source transcript`, {
      field: "sourceTranscript",
    });
  }
  return relationsStore.otherSide(edge, proposal.id);
}

/**
 * Validates an envelope against the card it is for (issue #184), on top of the envelope's own
 * shape (`assertValidProposalEnvelope`). A `'relation'` envelope needs a source item to link from,
 * which only a `kind = 'transcript'` card has. A transcript card accepts exactly two shapes: create
 * a new Event (`'database'` targeting Events), or link its transcript to an existing Event
 * (`'relation'` through the Transcripts `event` property) — the latter checked against the
 * relation's integrity and ownership rules now, with the same canonical errors the write itself
 * would raise. Returns the Transcription<->Event edge confirm must write for a transcript card,
 * `null` for any other card.
 */
async function assertValidEnvelopeForCard(
  client: PoolClient,
  config: ProposalActionConfig,
  proposal: ItemRow,
  envelope: ProposalEnvelope,
): Promise<TranscriptEventEdge | null> {
  await assertValidProposalEnvelope(client, envelope);
  if (proposal.properties.kind !== "transcript") {
    if (envelope.entityKind === "relation") {
      throw new ValidationError("entityKind 'relation' is only valid on a transcript proposal", {
        field: "entityKind",
      });
    }
    return null;
  }

  const transcriptId = await requireSourceTranscriptId(client, config, proposal);
  const transcriptsDatabaseId = await requireDatabaseIdByModuleId(client, TRANSCRIPTS_MODULE_ID);
  const eventPropertyId = await requireRelationPropertyId(client, transcriptsDatabaseId, TRANSCRIPT_EVENT_PROPERTY_KEY);
  switch (envelope.entityKind) {
    case "database": {
      const eventsDatabaseId = await requireDatabaseIdByModuleId(client, EVENTS_MODULE_ID);
      if (envelope.target !== eventsDatabaseId) {
        throw new ValidationError("A transcript proposal can only create an Event", { field: "target" });
      }
      break;
    }
    case "relation":
      if (envelope.properties.propertyKey !== TRANSCRIPT_EVENT_PROPERTY_KEY) {
        throw new ValidationError(
          `A transcript proposal can only link through the '${TRANSCRIPT_EVENT_PROPERTY_KEY}' relation`,
          { field: "properties" },
        );
      }
      await assertRelationCreatableWithClient(client, {
        relationPropertyId: eventPropertyId,
        callerItemId: transcriptId,
        targetItemId: envelope.target,
      });
      break;
    case "pageContent":
      throw new ValidationError("A transcript proposal cannot append page content", { field: "entityKind" });
    default: {
      const exhaustive: never = envelope.entityKind;
      throw new Error(`Unhandled proposal entityKind: ${String(exhaustive)}`);
    }
  }
  return { transcriptId, eventPropertyId };
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
 *
 * `credential` (issue #123) is the confirming human's separately-supplied secret for an MCP
 * server proposal — accepted only when `envelope.target` is the `mcpServers` database (a
 * `ValidationError` otherwise, so a credential can never land against an unrelated target by
 * mistake), and stored via `storeCredential` in the same transaction as the item create,
 * immediately before the row is locked `confirmed` below: since `createItemWithClient` and
 * `storeCredential` both run inside this function's caller-supplied transaction, either both
 * persist or neither does — a `storeCredential` failure rolls back the item create too,
 * satisfying "stores server and encrypted credential or neither." Not every server needs one
 * (e.g. a local `stdio` command with no auth), so a proposal with no `credential` argument at
 * all is confirmed normally, item-only.
 *
 * For `'relation'` (issue #184) the write is the generic relation write behind
 * `PUT /api/items/:id/relations/:propertyKey/:targetItemId`, from the card's source item to
 * `envelope.target`, and the result is that existing item. A `kind = 'transcript'` card also
 * gets its Transcription<->Event edge: for `'relation'` that edge is the relation write itself;
 * for `'database'` it is written right after the Event is created. Both run in the caller's one
 * transaction, so a failed edge write (e.g. the 1:1 relation's `cardinality_violation` when the
 * transcript or Event is already linked elsewhere) leaves no Event, no edge and the card still
 * `proposed`.
 */
export async function confirmProposalWithClient(
  client: PoolClient,
  config: ProposalActionConfig,
  proposalId: string,
  credential?: ConfirmProposalCredentialInput,
): Promise<ItemRow> {
  const proposal = await lockLiveProposal(client, config.processingProposalsDatabaseId, proposalId);
  const status = proposal.properties.status;
  if (status === "confirmed") return proposal;
  if (status !== "proposed") {
    throw new ValidationError(`Cannot confirm a proposal in status '${String(status)}'`, { field: "status" });
  }

  const envelope = proposal.properties.proposal as ProposalEnvelope | null;
  if (!envelope) throw new ValidationError("Proposal has no computed envelope to confirm", { field: "proposal" });
  const transcriptEventEdge = await assertValidEnvelopeForCard(client, config, proposal, envelope);

  let resultItemId: string;
  let resultLabel: string;
  if (envelope.entityKind === "database") {
    if (credential) {
      const targetDatabase = await databasesStore.getDatabase(client, envelope.target);
      if (targetDatabase?.ownerModuleId !== MCP_SERVERS_MODULE_ID) {
        throw new ValidationError("A credential may only be supplied when confirming an MCP server proposal", {
          field: "credential",
        });
      }
    }
    const created = await createItemWithClient(client, {
      databaseId: envelope.target,
      properties: envelope.properties,
    });
    resultItemId = created.id;
    resultLabel = await resolveResultLabel(client, envelope.target, created);
    if (credential) {
      await storeCredential(client, {
        itemId: created.id,
        credentialType: credential.credentialType,
        plaintext: credential.plaintext,
      });
    }
    if (transcriptEventEdge) {
      await createRelationWithClient(client, {
        relationPropertyId: transcriptEventEdge.eventPropertyId,
        callerItemId: transcriptEventEdge.transcriptId,
        targetItemId: created.id,
      });
    }
  } else if (envelope.entityKind === "relation") {
    // `assertValidEnvelopeForCard` above only accepts a 'relation' envelope on a transcript
    // card, through the Transcripts `event` property — so `transcriptEventEdge` names this write.
    if (!transcriptEventEdge) throw new Error(`Relation proposal ${proposal.id} has no source item to link from`);
    await createRelationWithClient(client, {
      relationPropertyId: transcriptEventEdge.eventPropertyId,
      callerItemId: transcriptEventEdge.transcriptId,
      targetItemId: envelope.target,
    });
    const [linked] = await itemsStore.getItemsByIds(client, [envelope.target]);
    resultItemId = envelope.target;
    resultLabel = linked ? await resolveResultLabel(client, linked.databaseId, linked) : envelope.target;
  } else {
    // Safe to cast without a further runtime check here: `assertValidProposalEnvelope`
    // above already rejects a 'pageContent' envelope whose `flavour` isn't a non-empty
    // string, or whose `fields`/`children` (if present) aren't a plain object / string
    // array respectively.
    const { flavour, fields, children } = envelope.properties as {
      flavour: string;
      fields?: Record<string, unknown>;
      children?: string[];
    };
    await putBlockWithClient(client, envelope.target, { id: proposal.id, flavour, fields, children }, "ai_agent");
    const [targetPage] = await itemsStore.getItemsByIds(client, [envelope.target]);
    resultItemId = envelope.target;
    resultLabel = targetPage ? await resolveResultLabel(client, targetPage.databaseId, targetPage) : envelope.target;
  }

  const updated = await updateItemWithClient(
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
  // Issue #106's "proposal transition" invalidation trigger: confirm/reject/revise change
  // the source Inbox item's displayed status but never touch the Inbox item itself, so
  // nothing else would invalidate its Journal day's cached list.
  await enqueueJournalInboxRecomputeForProposal(client, proposal.id);
  return updated;
}

/**
 * `POST /api/proposals/:id/reject` (issue #105): locks the proposal as `rejected` without
 * ever writing a destination. Idempotent under retry (an already-`rejected` proposal is
 * returned as-is); rejecting a `confirmed` proposal is refused, since its destination write
 * already happened and rejecting now could not undo it.
 */
export async function rejectProposalWithClient(
  client: PoolClient,
  config: ProposalActionConfig,
  proposalId: string,
  message?: string,
): Promise<ItemRow> {
  const proposal = await lockLiveProposal(client, config.processingProposalsDatabaseId, proposalId);
  const status = proposal.properties.status;
  if (status === "rejected") return proposal;
  if (status === "confirmed") {
    throw new ValidationError("Cannot reject a proposal that has already been confirmed", { field: "status" });
  }

  const updated = await updateItemWithClient(
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
  await enqueueJournalInboxRecomputeForProposal(client, proposal.id);
  return updated;
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
 * `database` to `pageContent` or vice versa atomically, or a transcript card from creating a
 * new Event to linking an existing one and back (issue #184) — never a partial patch onto the
 * existing one, since a partial merge of `target`/`properties` across different
 * `entityKind`s would produce a nonsensical envelope. The new envelope is checked against the
 * card as confirm would check it (`assertValidEnvelopeForCard`), so an invalid link target is
 * refused here with its canonical error rather than only at confirm. Refused on a locked (`confirmed`/
 * `rejected`) proposal, per the epic's "a locked card is never recomputed again"; allowed
 * from `needsClarification`/`invalid` as well as `proposed`, since a user resolving one of
 * those into a valid envelope is exactly how a proposal is meant to leave that state.
 */
export async function reviseProposalWithClient(
  client: PoolClient,
  config: ProposalActionConfig,
  proposalId: string,
  input: ReviseProposalInput,
): Promise<ItemRow> {
  const proposal = await lockLiveProposal(client, config.processingProposalsDatabaseId, proposalId);
  const status = proposal.properties.status;
  if (typeof status === "string" && LOCKED_PROPOSAL_STATUSES.has(status)) {
    throw new ValidationError(`Cannot revise a locked proposal (status '${status}')`, { field: "status" });
  }

  const envelope: ProposalEnvelope = {
    entityKind: input.entityKind,
    target: input.target,
    properties: input.properties,
  };
  await assertValidEnvelopeForCard(client, config, proposal, envelope);

  const updated = await updateItemWithClient(
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
  await enqueueJournalInboxRecomputeForProposal(client, proposal.id);
  return updated;
}
