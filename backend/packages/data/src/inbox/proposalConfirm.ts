import type { PoolClient } from "pg";
import { insertInboxOriginNotes } from "./originNote.js";
import { parseOccurrenceId } from "../calendar/eventOccurrenceId.js";
import { materializeEventOccurrence } from "../calendar/materializeEventOccurrence.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { createRelationIfAbsentWithClient } from "../chokePoint/relationOps.js";
import { putBlockWithClient } from "../docs/docStore.js";
import { pageContentV2Schema } from "./proposalEnvelope.js";
import { insertProposalPageContent } from "./proposalPageContent.js";
import { insertProposalPageSections } from "./proposalPageSections.js";
import { assertProposalVersion, incompatibleStatusError } from "./proposalPreconditions.js";
import { appendHistoryEntry, parseStoredProposalEnvelope, type ProposalEnvelope } from "./inboxTickAction.js";
import { insertItemOrigins } from "./itemOriginsStore.js";
import { requireRelationPropertyId, resolveItemOriginSource } from "./proposalItemOrigin.js";
import { confirmMailThreadCard } from "./mailThreadCard.js";
import { confirmRecordingCard } from "./recordingCardConfirm.js";
import { assertJournalEntryReferencesLive, confirmJournalEntry } from "./journalEntryConfirm.js";
import { relationEnvelopeMetadata, writeEnvelopeRelations } from "./proposalEnvelopeRelations.js";
import { createEnvelopeNewOptions } from "./proposalNewOptions.js";
import { assertRequiredFieldsHaveValues } from "./proposalEditorRules.js";
import { assertCardIsNotStdioMcpServer, normalizeEnvelopeForWrite } from "./proposalHiddenFields.js";
import { executeProposalSteps } from "./proposalSteps.js";
import { createEdgeRecorder, writeRecordedEdge, type EdgeRecorder } from "./proposalEdgeRecording.js";
import { effectiveStepRelations } from "./proposalStepGraph.js";
import { enqueueJournalInboxRecomputeForProposal } from "./journalInboxCompute.js";
import { runWhileConfirmingCard } from "./proposalReferences.js";
import { publishInboxCardChange } from "./inboxCardsRealtime.js";
import {
  CONFIRMING_USER_WRITER,
  TRANSCRIPT_EVENT_PROPERTY_KEY,
  assertValidEnvelopeForCard,
  lockLiveProposal,
  releaseTrashedEventOfPairingCard,
  requireDatabaseIdByModuleId,
  resolveResultLabel,
  unsupportedEntityKindError,
  type ConfirmProposalCredentialInput,
  type ConfirmationResult,
  type EnvelopeForCard,
  type ProposalActionConfig,
} from "./proposalActions.js";
import { MCP_SERVERS_MODULE_ID } from "../seed/mcpModuleKeys.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { addSpeakersAsEventParticipants } from "../transcription/transcriptEventParticipants.js";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import { enqueueMcpServerSyncForConfirm } from "../mcp/mcpSync.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import type { ItemRow } from "../types.js";

interface AddedRelation {
  edgeId: string;
  relationPropertyId: string;
  callerItemId: string;
  targetItemId: string;
}

interface StepResult {
  ref: string;
  itemId: string;
  databaseId: string;
}

/** Everything one confirm's destination write reads, validated and normalized before any write. */
interface ConfirmContext {
  client: PoolClient;
  config: ProposalActionConfig;
  proposal: ItemRow;
  envelope: ProposalEnvelope;
  /** `envelope` normalized for the write (`normalizeEnvelopeForWrite`). */
  written: ProposalEnvelope;
  validated: EnvelopeForCard;
  credential?: ConfirmProposalCredentialInput;
  actingUserId?: string;
  markdownPageContent: boolean;
  /** Edges between existing items this confirm writes or deletes, stored in its history entry for the undo. */
  recorder: EdgeRecorder;
  addedRelations: AddedRelation[];
}

/** What the destination write produced, for the confirmation results and the card update. */
interface ConfirmedWrite {
  resultItemId: string;
  resultLabel: string;
  stepResults: StepResult[];
  blockIds: string[];
  /** The `ref` of the result whose `followUp` is `transcriptionQueued`, set only when the intake enqueued it. */
  transcriptionQueuedRef: string | null;
  reusedFileRefs: ReadonlySet<string>;
  /** The item a `'relation'` envelope linked: its `target`, or the item its synthetic occurrence id became. */
  linkedTargetId: string | null;
  /** The MCP server item whose `mcpServerSync` job this confirm enqueued. */
  queuedMcpSyncItemId: string | null;
}

const NO_FOLLOW_UPS: Pick<
  ConfirmedWrite,
  "transcriptionQueuedRef" | "reusedFileRefs" | "linkedTargetId" | "queuedMcpSyncItemId"
> = {
  transcriptionQueuedRef: null,
  reusedFileRefs: new Set<string>(),
  linkedTargetId: null,
  queuedMcpSyncItemId: null,
};

function isHeadingUnavailable(error: ValidationError): boolean {
  const details: unknown = error.details;
  return (
    typeof details === "object" && details !== null && "reason" in details && details.reason === "heading_unavailable"
  );
}

function credentialNotAllowed(): ValidationError {
  return new ValidationError("A credential may only be supplied when confirming an MCP server proposal", {
    field: "credential",
  });
}

/**
 * `POST /api/proposals/:id/confirm`: the only path by which an agent's proposal becomes a destination write, always
 * in user context. An already `confirmed` card is returned as is (whatever `ifVersion` says), so retries never write
 * twice. The envelope is re-validated against current destination state. Everything runs in the caller's
 * transaction, so any failure leaves nothing written and the card `proposed`.
 *
 * - Old-shape `pageContent` uses the proposal id as block id, so a retried confirm overwrites instead of duplicating.
 * - `credential` is accepted only for `mcpServers` and stored with the item, so both persist or neither; with an
 *   acting user the confirm also enqueues `mcpServerSync`.
 * - A transcript card's Event edge first deletes the transcript's edge to a trashed Event (one Event allowed); a
 *   created Event first gets its relations and `people` edges for mapped speakers except the tenant's own person.
 * - `newOptions` are created before the item, so options, item and card commit together.
 * - Edges written or deleted on existing items are recorded in the confirmation entry, so undo reverses only those.
 *
 * `ifVersion` is checked after the lock, the `confirmed` answer and the refusal of other statuses (409).
 */
export async function confirmProposalWithClient(
  client: PoolClient,
  config: ProposalActionConfig,
  proposalId: string,
  credential?: ConfirmProposalCredentialInput,
  actingUserId?: string,
  ifVersion?: string,
): Promise<ItemRow> {
  const proposal = await lockLiveProposal(client, config.processingProposalsDatabaseId, proposalId);
  const status = proposal.properties.status;
  if (status === "confirmed") return proposal;
  if (status !== "proposed") {
    throw incompatibleStatusError(`Cannot confirm a proposal in status '${String(status)}'`, status);
  }
  assertProposalVersion(proposal, ifVersion);
  // A step may archive an item this card refers to; the reference hooks must not invalidate the card being confirmed.
  return runWhileConfirmingCard(client, proposal.id, async () => {
    const envelope = parseStoredProposalEnvelope(proposal.properties.proposal, proposal.id);
    if (!envelope) throw new ValidationError("Proposal has no computed envelope to confirm", { field: "proposal" });
    if ("unknownKind" in envelope) throw unsupportedEntityKindError(envelope.entityKind);
    // The Journal database, the area and the project may be gone since the card was computed: a 409, before any write.
    await assertJournalEntryReferencesLive(client, envelope);
    const markdownPageContent = envelope.entityKind === "pageContent" && Object.hasOwn(envelope.properties, "markdown");
    if (markdownPageContent && proposal.properties.kind === "transcript")
      throw new ValidationError("A transcript proposal cannot target page content", { field: "entityKind" });
    await assertCardIsNotStdioMcpServer(client, envelope);
    let validated: EnvelopeForCard;
    try {
      validated = await assertValidEnvelopeForCard(client, config, proposal, envelope);
    } catch (error) {
      // A heading removed since computation is a 409 the client can answer with a new choice; nothing is written.
      if (markdownPageContent && error instanceof ValidationError && isHeadingUnavailable(error)) {
        throw new ConflictError("The chosen heading no longer exists on the page", { field: "placement" });
      }
      throw error;
    }
    await assertRequiredFieldsHaveValues(client, proposal, envelope);
    const written = await normalizeEnvelopeForWrite(client, proposal, envelope, validated.targetDatabase);

    const context: ConfirmContext = {
      client,
      config,
      proposal,
      envelope,
      written,
      validated,
      credential,
      actingUserId,
      markdownPageContent,
      recorder: createEdgeRecorder(),
      addedRelations: [],
    };
    const outcome = await writeDestination(context);
    if (validated.transcriptCardEdge?.role === "speaker") {
      await addSpeakerPersonToTranscriptEvent(context, validated.transcriptCardEdge.transcriptId, outcome.resultItemId);
    }
    const results = await buildConfirmationResults(client, envelope, outcome);

    const updated = await updateItemWithClient(
      client,
      {
        databaseId: config.processingProposalsDatabaseId,
        itemId: proposal.id,
        propertiesPatch: {
          status: "confirmed",
          resultItemId: outcome.resultItemId,
          resultLabel: outcome.resultLabel,
          results,
          history: appendHistoryEntry(proposal.properties.history, "Confirmed by user.", "user", {
            ...(context.addedRelations.length ? { addedRelations: context.addedRelations } : {}),
            writtenRelations: context.recorder.written,
            removedRelations: context.recorder.removed,
          }),
        },
      },
      {
        allowedSystemKeys: ["status", "resultItemId", "resultLabel", "results", "history"],
        writer: CONFIRMING_USER_WRITER,
        actingUserId,
      },
    );
    publishInboxCardChange(client, proposal.id, "closed");
    // Confirm/reject/revise change the source Inbox item's displayed status without touching the item, so nothing
    // else would invalidate its Journal day's cached list.
    await enqueueJournalInboxRecomputeForProposal(client, proposal.id);
    return updated;
  });
}

/** A `mailThread` card is recognized by its validated thread, whatever its envelope kind. */
function writeDestination(context: ConfirmContext): Promise<ConfirmedWrite> {
  const { mailThreadItemId } = context.validated;
  if (mailThreadItemId !== undefined) return confirmMailThreadDestination(context, mailThreadItemId);
  switch (context.envelope.entityKind) {
    case "transcription":
      return confirmTranscriptionDestination(context);
    case "journalEntry":
      return confirmJournalEntryDestination(context);
    case "database":
      return confirmDatabaseDestination(context);
    case "relation":
      return confirmRelationDestination(context);
    case "pageContent":
      return confirmPageContentDestination(context);
  }
}

async function confirmMailThreadDestination(
  { client, written, credential, actingUserId }: ConfirmContext,
  mailThreadItemId: string,
): Promise<ConfirmedWrite> {
  if (credential) throw credentialNotAllowed();
  const task = await confirmMailThreadCard(client, mailThreadItemId, written.properties, actingUserId);
  const stepResults = [{ ref: "primary", itemId: task.id, databaseId: task.databaseId }];
  const resultLabel = await resolveResultLabel(client, task.databaseId, task);
  return { ...NO_FOLLOW_UPS, resultItemId: task.id, resultLabel, stepResults, blockIds: [] };
}

async function confirmTranscriptionDestination({
  client,
  config,
  proposal,
  envelope,
  validated,
  credential,
  actingUserId,
}: ConfirmContext): Promise<ConfirmedWrite> {
  if (credential) throw credentialNotAllowed();
  const { recording } = validated;
  if (!recording) throw new Error(`Recording proposal ${proposal.id} was validated without its source`);
  const started = await confirmRecordingCard(
    client,
    config,
    proposal,
    envelope.target,
    recording,
    CONFIRMING_USER_WRITER,
    actingUserId,
  );
  return {
    ...NO_FOLLOW_UPS,
    resultItemId: started.fileItemId,
    resultLabel: recording.properties.name,
    stepResults: [{ ref: "primary", itemId: started.fileItemId, databaseId: started.filesDatabaseId }],
    blockIds: [],
    transcriptionQueuedRef: started.transcriptionQueued ? "primary" : null,
  };
}

async function confirmJournalEntryDestination({
  client,
  proposal,
  envelope,
  actingUserId,
  recorder,
}: ConfirmContext): Promise<ConfirmedWrite> {
  const entry = await confirmJournalEntry(client, proposal.id, envelope, CONFIRMING_USER_WRITER, actingUserId);
  recorder.written.push(...entry.recordedEdges.written);
  const { resultItemId, resultLabel, stepResults, blockIds } = entry;
  return { ...NO_FOLLOW_UPS, resultItemId, resultLabel, stepResults, blockIds };
}

/**
 * Creates the item (or every active step of a multi-step envelope). On a transcript card it is an Event, or a person
 * for a speaker card, written before the transcript's own edge.
 */
async function confirmDatabaseDestination({
  client,
  config,
  proposal,
  envelope,
  written,
  validated: { transcriptCardEdge, targetDatabase },
  credential,
  actingUserId,
  recorder,
  addedRelations,
}: ConfirmContext): Promise<ConfirmedWrite> {
  if (credential && targetDatabase?.ownerModuleId !== MCP_SERVERS_MODULE_ID) throw credentialNotAllowed();
  const origin = await resolveItemOriginSource(client, config, proposal, transcriptCardEdge?.transcriptId ?? null);
  let stepResults: StepResult[] = [];
  let blockIds: string[] = [];
  const reusedFileRefs = new Set<string>();
  // A multi-step envelope writes every active step; a single-step one keeps the direct path below.
  let created: ItemRow;
  let createdItemIds: string[];
  let resultDatabaseId = envelope.target;
  if (written.operations) {
    const executed = await executeProposalSteps(client, written.operations, {
      writer: CONFIRMING_USER_WRITER,
      actingUserId,
      sourceInboxItemId: origin.inboxItemId,
    });
    const [primaryItem] = await itemsStore.getItemsByIds(client, [executed.primaryItemId]);
    if (!primaryItem) throw new Error(`Primary step item ${executed.primaryItemId} disappeared during confirm`);
    created = primaryItem;
    resultDatabaseId = executed.primaryDatabaseId;
    createdItemIds = executed.createdItemIds;
    stepResults = executed.executedSteps;
    for (const file of executed.fileFromAttachments) if (!file.created) reusedFileRefs.add(file.ref);
    recorder.written.push(...executed.recordedEdges.written);
    recorder.removed.push(...executed.recordedEdges.removed);
  } else {
    // The proposed options are created first, in this transaction, and their keys replace the labels.
    const properties = await createEnvelopeNewOptions(client, envelope, written.properties, actingUserId);
    created = await createItemWithClient(
      client,
      { databaseId: envelope.target, properties },
      { writer: CONFIRMING_USER_WRITER, actingUserId },
    );
    createdItemIds = [created.id];
  }
  await insertItemOrigins(client, createdItemIds, origin);
  await insertInboxOriginNotes(client, createdItemIds, origin.inboxItemId, actingUserId);
  // The created item's page sections, in this transaction like the item.
  if (envelope.pageSections) {
    blockIds = await insertProposalPageSections(client, proposal.id, created.id, envelope.pageSections);
  }
  if (!envelope.operations) stepResults = [{ ref: "primary", itemId: created.id, databaseId: created.databaseId }];
  const resultLabel = await resolveResultLabel(client, resultDatabaseId, created);
  if (credential) {
    await storeCredential(client, {
      itemId: created.id,
      credentialType: credential.credentialType,
      plaintext: credential.plaintext,
    });
  }
  // Queue the tool load, which runs after commit, with or without a credential. Without an acting user nothing is
  // queued: the sync would have nobody to attribute its connection to.
  const queuedMcpSyncItemId = await enqueueMcpServerSyncForConfirm(client, targetDatabase, created.id, actingUserId);
  // The created Event gets its envelope relations and participants before the transcript's own edge. Multi-step
  // relations live on steps.
  if (!envelope.operations) {
    await writeEnvelopeRelations(
      client,
      envelope.target,
      created.id,
      envelope.relations,
      CONFIRMING_USER_WRITER,
      actingUserId,
    );
  }
  if (transcriptCardEdge?.role === "event") {
    addedRelations.push(
      ...(await addSpeakersAsEventParticipants(
        client,
        { transcriptId: transcriptCardEdge.transcriptId, eventId: created.id },
        CONFIRMING_USER_WRITER,
        actingUserId,
      )),
    );
  }
  if (transcriptCardEdge) {
    await releaseTrashedEventOfPairingCard(client, transcriptCardEdge, actingUserId);
    await writeRecordedEdge(
      client,
      recorder,
      {
        relationPropertyId: transcriptCardEdge.relationPropertyId,
        callerItemId: transcriptCardEdge.transcriptId,
        targetItemId: created.id,
        ...(transcriptCardEdge.role === "speaker" ? { metadata: { speaker: transcriptCardEdge.speaker } } : {}),
      },
      CONFIRMING_USER_WRITER,
      actingUserId,
    );
  }
  return {
    ...NO_FOLLOW_UPS,
    resultItemId: created.id,
    resultLabel,
    stepResults,
    blockIds,
    reusedFileRefs,
    queuedMcpSyncItemId,
  };
}

/** Links the transcript to an existing item (an Event, or a person for a speaker card). */
async function confirmRelationDestination({
  client,
  proposal,
  envelope,
  validated: { transcriptCardEdge },
  actingUserId,
  recorder,
}: ConfirmContext): Promise<ConfirmedWrite> {
  // `assertValidEnvelopeForCard` accepts a 'relation' envelope only on a transcript card, so this edge names it.
  if (!transcriptCardEdge) throw new Error(`Relation proposal ${proposal.id} has no source item to link from`);
  // A synthetic occurrence id becomes its Events item here, in this transaction; a repeat finds the item the first
  // call created, and a cancelled occurrence's item refuses the link below.
  const occurrence = parseOccurrenceId(envelope.target);
  const linkedTargetId = occurrence
    ? (
        await materializeEventOccurrence(client, {
          ...occurrence,
          options: { writer: CONFIRMING_USER_WRITER, actingUserId },
        })
      ).item.id
    : envelope.target;
  await releaseTrashedEventOfPairingCard(client, transcriptCardEdge, actingUserId);
  await writeRecordedEdge(
    client,
    recorder,
    {
      relationPropertyId: transcriptCardEdge.relationPropertyId,
      callerItemId: transcriptCardEdge.transcriptId,
      targetItemId: linkedTargetId,
      metadata: relationEnvelopeMetadata(envelope),
    },
    CONFIRMING_USER_WRITER,
    actingUserId,
  );
  const [linked] = await itemsStore.getItemsByIds(client, [linkedTargetId]);
  const [transcript] = await itemsStore.getItemsByIds(client, [transcriptCardEdge.transcriptId]);
  if (!transcript) throw new Error("Source transcript disappeared during confirm");
  return {
    ...NO_FOLLOW_UPS,
    resultItemId: linkedTargetId,
    resultLabel: linked ? await resolveResultLabel(client, linked.databaseId, linked) : linkedTargetId,
    stepResults: [{ ref: "primary", itemId: transcript.id, databaseId: transcript.databaseId }],
    blockIds: [],
    linkedTargetId,
  };
}

async function confirmPageContentDestination({
  client,
  proposal,
  envelope,
  markdownPageContent,
}: ConfirmContext): Promise<ConfirmedWrite> {
  let blockIds: string[];
  if (markdownPageContent) {
    // Validated by `assertValidProposalEnvelope`, so the parse cannot fail; it types the stored properties.
    const content = pageContentV2Schema.parse(envelope.properties);
    blockIds = await insertProposalPageContent(client, proposal.id, envelope.target, content);
  } else {
    // `assertValidProposalEnvelope` already checked `flavour`, `fields` and `children`, so the cast is safe.
    const { flavour, fields, children } = envelope.properties as {
      flavour: string;
      fields?: Record<string, unknown>;
      children?: string[];
    };
    const inserted = await putBlockWithClient(
      client,
      envelope.target,
      { id: proposal.id, flavour, fields, children },
      "user",
    );
    blockIds = inserted ? [proposal.id] : [];
  }
  const [targetPage] = await itemsStore.getItemsByIds(client, [envelope.target]);
  if (!targetPage) throw new Error("Target page disappeared during confirm");
  return {
    ...NO_FOLLOW_UPS,
    resultItemId: envelope.target,
    resultLabel: await resolveResultLabel(client, targetPage.databaseId, targetPage),
    stepResults: [{ ref: "primary", itemId: targetPage.id, databaseId: targetPage.databaseId }],
    blockIds,
  };
}

/** A speaker card's person joins the `people` of the transcript's Event, when it has one. */
async function addSpeakerPersonToTranscriptEvent(
  { client, actingUserId, addedRelations }: ConfirmContext,
  transcriptId: string,
  personItemId: string,
): Promise<void> {
  const [transcript] = await itemsStore.getItemsByIds(client, [transcriptId]);
  if (!transcript) throw new Error("Source transcript disappeared during confirm");
  const eventProperty = await requireRelationPropertyId(client, transcript.databaseId, TRANSCRIPT_EVENT_PROPERTY_KEY);
  const definition = await relationsStore.getRelationDefinitionByPropertyId(client, eventProperty);
  if (!definition) throw new NotFoundError("Transcript event relation not found");
  const events = await relationsStore.listRelationsForItem(client, definition.id, transcript.id);
  if (events.length > 1) throw new ConflictError("Transcript has multiple linked events");
  const event = events[0] ? relationsStore.otherSide(events[0], transcript.id) : null;
  if (!event) return;
  const eventsDatabase = await requireDatabaseIdByModuleId(client, EVENTS_MODULE_ID);
  const relationPropertyId = await requireRelationPropertyId(client, eventsDatabase, "people");
  const added = await createRelationIfAbsentWithClient(
    client,
    { relationPropertyId, callerItemId: event, targetItemId: personItemId },
    undefined,
    CONFIRMING_USER_WRITER,
    actingUserId,
  );
  if (added.inserted)
    addedRelations.push({
      edgeId: added.edge.id,
      relationPropertyId,
      callerItemId: event,
      targetItemId: personItemId,
    });
}

/** One result per written step, the primary first, with the labels of the items each links to. */
async function buildConfirmationResults(
  client: PoolClient,
  envelope: ProposalEnvelope,
  outcome: ConfirmedWrite,
): Promise<ConfirmationResult[]> {
  const { stepResults, linkedTargetId, reusedFileRefs, transcriptionQueuedRef, queuedMcpSyncItemId, blockIds } =
    outcome;
  const idsByRef = new Map(stepResults.map((step) => [step.ref, step.itemId]));
  const results: ConfirmationResult[] = [];
  for (const written of stepResults) {
    const [item] = await itemsStore.getItemsByIds(client, [written.itemId]);
    const database = await databasesStore.getDatabase(client, written.databaseId);
    if (!item || !database) throw new Error("Confirmed result item or database disappeared");
    const step = envelope.operations?.find((operation) => operation.ref === written.ref);
    const requestedRelations = step
      ? effectiveStepRelations(step)
      : envelope.entityKind === "relation"
        ? {}
        : (envelope.relations ?? {});
    const targets: Array<string | undefined> = [];
    if (linkedTargetId !== null) targets.push(linkedTargetId);
    const requests: Array<{ definitionId: string; target: string }> = [];
    const resolved = new Map<string, Array<string | undefined>>();
    const definitions = new Map<string, string>();
    for (const [key, values] of Object.entries(requestedRelations)) {
      const ids = values.map((value) => (typeof value === "string" ? value : idsByRef.get(value.ref)));
      resolved.set(key, ids);
      if (reusedFileRefs.has(written.ref)) {
        const property = await propertiesStore.getPropertyByKey(client, written.databaseId, key);
        const definition = property && (await relationsStore.getRelationDefinitionByPropertyId(client, property.id));
        if (!definition) throw new Error(`Missing confirmed relation definition for ${key}`);
        definitions.set(key, definition.id);
        for (const target of ids) if (target !== undefined) requests.push({ definitionId: definition.id, target });
      }
    }
    const retained = new Map<string, Set<string>>();
    if (requests.length > 0) {
      const { rows } = await client.query<{ definition_id: string; target_id: string }>(
        `SELECT r.relation_definition_id AS definition_id,
                CASE WHEN r.item_a = $3::uuid THEN r.item_b ELSE r.item_a END AS target_id
         FROM item_relations r
         JOIN unnest($1::uuid[], $2::uuid[]) AS wanted(definition_id, target_id)
           ON wanted.definition_id = r.relation_definition_id
          AND ((r.item_a = $3::uuid AND r.item_b = wanted.target_id)
            OR (r.item_b = $3::uuid AND r.item_a = wanted.target_id))
         ORDER BY r.relation_definition_id, r.id FOR SHARE OF r`,
        [requests.map((request) => request.definitionId), requests.map((request) => request.target), item.id],
      );
      for (const row of rows) {
        const ids = retained.get(row.definition_id) ?? new Set<string>();
        ids.add(row.target_id);
        retained.set(row.definition_id, ids);
      }
    }
    for (const [key, ids] of resolved) {
      if (!reusedFileRefs.has(written.ref)) {
        targets.push(...ids);
        continue;
      }
      const definitionId = definitions.get(key);
      if (!definitionId) throw new Error(`Missing confirmed relation definition for ${key}`);
      const existing = retained.get(definitionId);
      for (const id of ids) if (id !== undefined && existing?.has(id)) targets.push(id);
    }
    const linked = await itemsStore.getItemsByIds(
      client,
      targets.filter((id): id is string => id !== undefined),
    );
    const linkedById = new Map(linked.map((item) => [item.id, item]));
    const linkLabels: string[] = [];
    for (const targetId of targets) {
      const target = targetId === undefined ? undefined : linkedById.get(targetId);
      if (target) linkLabels.push(await resolveResultLabel(client, target.databaseId, target));
    }
    const dateValue =
      database.key === "events" ? item.properties.date : database.key === "journal" ? item.properties.period : null;
    const date =
      typeof dateValue === "string" && /^\d{4}-\d{2}-\d{2}(?:$|T)/.test(dateValue) ? dateValue.slice(0, 10) : null;
    results.push({
      ref: written.ref,
      itemId: item.id,
      databaseKey: database.key,
      label: await resolveResultLabel(client, database.id, item),
      role: step?.role ?? "primary",
      date,
      linkLabels,
      followUp:
        written.ref === transcriptionQueuedRef
          ? "transcriptionQueued"
          : item.id === queuedMcpSyncItemId
            ? "mcpSyncQueued"
            : null,
      updatedAt: item.updatedAt,
      blockIds: written.ref === "primary" ? blockIds : [],
    });
  }
  results.sort((a, b) => Number(b.role === "primary") - Number(a.role === "primary"));
  return results;
}
