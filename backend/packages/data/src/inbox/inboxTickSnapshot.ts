import type { PoolClient } from "pg";
import { z } from "zod";
import { getItemsByIds } from "../chokePoint/itemsStore.js";
import { readPageSummary } from "../docs/pageSummary.js";
import { ValidationError } from "../errors.js";
import type { ItemRow } from "../types.js";
import type { ProcessingMethod } from "./inboxTypesStore.js";
import type { RecognitionType, RecognitionCandidate } from "./inboxRecognition.js";
import type {
  ProposalEnvelope,
  ComputedProposalEntityKind,
  ProposalNewOption,
  ProposalPageSection,
} from "./proposalEnvelope.js";
import {
  MAX_PROPOSAL_OPERATIONS,
  buildProposalSteps,
  type ProposalComputationOperation,
} from "./proposalOperations.js";

export interface ProposalComputationInput {
  recognition?: boolean;
  activeTypes?: RecognitionType[];
  /** The Inbox item the proposal is for. */
  sourceItem: ItemRow;
  /** The Inbox item's resolved, recognized type. */
  type: ItemRow | null;
  entityKind: ComputedProposalEntityKind;
  /** Resolved target database id for `entityKind: 'database'`; absent for `'pageContent'`, where the target page is itself part of the content decision. */
  targetDatabaseId?: string;
  /** The module id of the target database, for `entityKind: 'database'`; the primary operation of a multi-step answer must write to it. */
  targetModuleId?: string;
  /** The tenant's Journal database id, for `entityKind: 'journalEntry'` (issue gh-1982); the server-owned `target` of the envelope. */
  journalDatabaseId?: string;
  /** The source item's date (`YYYY-MM-DD`), for `entityKind: 'journalEntry'`: the day the entry lands on when the answer names none. */
  sourceDate?: string;
  /** The language (the person's `users.locale`, e.g. `cs`) the proposal's person-facing texts must be written in. */
  locale: string;
  /** The project the heartbeat belongs to (`ActionContext.projectItemId`); the model call is attributed to it. */
  projectItemId: string;
  /** The stored state of the card this is a recompute for (issue gh-1987); absent for a first computation. */
  previousProposal?: PreviousProposalState;
}

/** The parts of an existing card's state a recompute must respect: only those that are set (neither absent nor null). */
export interface PreviousProposalState {
  /** The last automated proposal. */
  aiProposal?: unknown;
  history?: unknown;
  /** The keys of the proposal the person edited. */
  userEditedKeys?: unknown;
}

/** The set parts of `card`'s `aiProposal`, `history` and `userEditedKeys`; `undefined` when none is set or there is no card. */
function previousProposalState(card: ItemRow | null): PreviousProposalState | undefined {
  if (!card) return undefined;
  const { aiProposal, history, userEditedKeys } = card.properties;
  const state: PreviousProposalState = {
    ...(aiProposal === undefined || aiProposal === null ? {} : { aiProposal }),
    ...(history === undefined || history === null ? {} : { history }),
    ...(userEditedKeys === undefined || userEditedKeys === null ? {} : { userEditedKeys }),
  };
  return Object.keys(state).length === 0 ? undefined : state;
}

export interface ProposalComputationResult {
  candidates?: RecognitionCandidate[];
  /** Server-derived identity of the candidate and destination used to normalize recognition output. */
  recognitionBinding?: {
    candidate: RecognitionCandidate;
    type: RecognitionType | null;
    targetModuleId: string | null;
    targetDatabaseId: string | null;
  };
  /**
   * The target page id, for `entityKind: 'pageContent'` — ignored for `'database'`, whose target is always the type's resolved
   * `targetDatabase` id. For `'journalEntry'` the target is server-owned, so a result that carries one is refused.
   */
  target?: string;
  properties: Record<string, unknown>;
  relations?: Record<string, string[]>;
  /**
   * For a single-step `entityKind: 'database'` answer only: the page sections the created item gets on confirm
   * (issue gh-1974), stored on the envelope as `pageSections`. Ignored for a multi-step answer and for the other kinds.
   */
  pageSections?: ProposalPageSection[];
  /**
   * For a single-step `entityKind: 'database'` answer only: the select options the answer proposes to create (issue
   * gh-1994), stored on the envelope as `newOptions`; a value of `properties` names one as `{ newOption: "<label>" }`.
   * Ignored for a multi-step answer and for the other kinds.
   */
  newOptions?: ProposalNewOption[];
  invalidProposal?: "workspaceReference" | "unrepresentableOperations";
  /**
   * Present only when the answer has more than one operation (at most `MAX_PROPOSAL_OPERATIONS`) or an operation
   * marked `primary` (issue gh-1992); then `buildProposalEnvelope` stores a multi-step envelope. A single unmarked
   * operation is returned as `properties`.
   */
  operations?: ProposalComputationOperation[];
  /** The model's localized explanation, stored on the card after trimming and capping at 500 characters. */
  reason?: string;
  /** The model's confidence in the proposal. Not read by the tick until issue #1495. */
  confidence?: number;
}

/**
 * The content-level decision (issue #223): which project/page an Inbox source becomes,
 * or which property values fill its target database row. Backed by an LLM call — prompt
 * engineering is out of this issue's scope, so this is a pluggable/injected function, the
 * same shape as `scheduler/actions.ts`'s `RunAgentFn`/`coreAgentRunAction`. Must never
 * write to any target database or page itself (issue #223's "no target write" guarantee)
 * — it only computes values in memory; `createSemprecTickAction` is solely responsible
 * for writing the resulting envelope into `processingProposals`.
 */
export type ComputeSemprecProposalFn = (input: ProposalComputationInput) => Promise<ProposalComputationResult>;

export interface TickSnapshot {
  recognition?: boolean;
  activeTypes?: RecognitionType[];
  sourceTypeId: string | null;
  item: ItemRow;
  type: ItemRow | null;
  processingMethod: ProcessingMethod;
  entityKind: ComputedProposalEntityKind;
  targetDatabaseId?: string;
  targetModuleId?: string;
  journalDatabaseId?: string;
  existingProposal: ItemRow | null;
  fingerprint: string;
  locale: string;
}

/** The source item's `date` when it is a string; its form is checked with the rest of the envelope. */
function sourceItemDate(item: ItemRow): string | undefined {
  const date = item.properties.date;
  return typeof date === "string" ? date : undefined;
}

/** The input of the computation function for `snapshot`; `projectItemId` is the heartbeat's project. */
export function tickComputationInput(snapshot: TickSnapshot, projectItemId: string): ProposalComputationInput {
  const previousProposal = previousProposalState(snapshot.existingProposal);
  return {
    recognition: snapshot.recognition,
    activeTypes: snapshot.activeTypes,
    sourceItem: snapshot.item,
    type: snapshot.type,
    entityKind: snapshot.entityKind,
    targetDatabaseId: snapshot.targetDatabaseId,
    targetModuleId: snapshot.targetModuleId,
    ...(snapshot.entityKind === "journalEntry"
      ? { journalDatabaseId: snapshot.journalDatabaseId, sourceDate: sourceItemDate(snapshot.item) }
      : {}),
    locale: snapshot.locale,
    projectItemId,
    ...(previousProposal ? { previousProposal } : {}),
  };
}

/**
 * The envelope of a `journalEntry` snapshot: `target` is the Journal database the snapshot resolved, `date` defaults to
 * the source item's date, and an area is dropped when the answer also names a project, because the area of a Journal
 * entry is derived from its project. Throws a `ValidationError` for a result that carries a `target` of its own.
 */
function buildJournalEntryEnvelope(snapshot: TickSnapshot, result: ProposalComputationResult): ProposalEnvelope {
  if (result.target !== undefined)
    throw new ValidationError("The target of a journal entry proposal is set by the server", { field: "target" });
  if (!snapshot.journalDatabaseId)
    throw new Error(`Snapshot for Inbox item ${snapshot.item.id} (entityKind 'journalEntry') has no journalDatabaseId`);
  const { areaId, ...rest } = result.properties;
  const date = rest.date === undefined ? sourceItemDate(snapshot.item) : rest.date;
  return {
    entityKind: "journalEntry",
    target: snapshot.journalDatabaseId,
    properties: {
      ...rest,
      ...(date === undefined ? {} : { date }),
      ...(areaId !== undefined && rest.projectId === undefined ? { areaId } : {}),
    },
  };
}

/**
 * `buildProposalEnvelope` with the `ValidationError` it raises for a result it refuses returned instead of thrown, so
 * the write phase records the refusal the way it records an envelope that fails validation (`needsClarification`).
 */
export function buildTickEnvelope(
  snapshot: TickSnapshot,
  result: ProposalComputationResult,
): ProposalEnvelope | ValidationError {
  try {
    return buildProposalEnvelope(snapshot, result);
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
}

/** Combines the external call's result with the snapshot into a stored envelope — no I/O. */
export function buildProposalEnvelope(snapshot: TickSnapshot, result: ProposalComputationResult): ProposalEnvelope {
  if (snapshot.entityKind === "journalEntry") return buildJournalEntryEnvelope(snapshot, result);
  if (snapshot.entityKind === "database") {
    if (!snapshot.targetDatabaseId)
      throw new Error(`Snapshot for Inbox item ${snapshot.item.id} (entityKind 'database') has no targetDatabaseId`);
    const operations = result.operations?.slice(0, MAX_PROPOSAL_OPERATIONS);
    // A marked operation (issue gh-1992) is a multi-step answer even alone: its primary step stands for the record.
    if (operations && (operations.length > 1 || operations.some((operation) => operation.primary === true))) {
      const steps = buildProposalSteps(operations, snapshot.targetModuleId);
      const primary = steps.find((step) => step.role === "primary")!;
      return {
        entityKind: "database",
        target: snapshot.targetDatabaseId,
        properties: primary.properties ?? {},
        operations: steps,
      };
    }
    return {
      entityKind: "database",
      target: snapshot.targetDatabaseId,
      properties: result.properties,
      ...(result.relations ? { relations: result.relations } : {}),
      ...(result.pageSections ? { pageSections: result.pageSections } : {}),
      ...(result.newOptions?.length ? { newOptions: result.newOptions } : {}),
    };
  }
  if (!result.target)
    throw new Error(
      `Proposal computation for Inbox item ${snapshot.item.id} (entityKind 'pageContent') did not return a 'target'`,
    );
  return { entityKind: "pageContent", target: result.target, properties: result.properties };
}

/** Resolve model-only heading text after the source fingerprint is revalidated. */
export async function resolveModelPagePlacement(
  client: PoolClient,
  envelope: ProposalEnvelope,
): Promise<ProposalEnvelope> {
  if (envelope.entityKind !== "pageContent" || !Object.hasOwn(envelope.properties, "markdown")) return envelope;
  const placement = z.object({ afterHeadingText: z.string() }).strict().safeParse(envelope.properties.placement);
  if (!placement.success) return envelope;
  const target = z.string().uuid().safeParse(envelope.target);
  const item = target.success ? (await getItemsByIds(client, [target.data]))[0] : undefined;
  let afterHeading: string | undefined;
  if (item) {
    const page = await readPageSummary(client, item.id, "en");
    const sought = placement.data.afterHeadingText.trim().toLowerCase();
    afterHeading = sought
      ? page.headings.find((heading) => heading.text.trim().toLowerCase() === sought)?.id
      : undefined;
  }
  return {
    ...envelope,
    properties: { ...envelope.properties, placement: afterHeading ? { afterHeading } : "end" },
  };
}
