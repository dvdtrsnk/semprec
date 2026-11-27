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
  sourceItem: ItemRow;
  type: ItemRow | null;
  entityKind: ComputedProposalEntityKind;
  /** Absent for `'pageContent'`, where the target page is part of the content decision. */
  targetDatabaseId?: string;
  /** The primary operation of a multi-step answer must write to this module. */
  targetModuleId?: string;
  /** For `journalEntry`: the server-owned `target` of the envelope. */
  journalDatabaseId?: string;
  /** For `journalEntry`: the day the entry lands on when the answer names none. */
  sourceDate?: string;
  /** The language the person-facing texts must be written in. */
  locale: string;
  /** The model call is attributed to this project. */
  projectItemId: string;
  /** Absent for a first computation. */
  previousProposal?: PreviousProposalState;
}

/** Only the parts that are set (neither absent nor null). */
export interface PreviousProposalState {
  aiProposal?: unknown;
  history?: unknown;
  userEditedKeys?: unknown;
}

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
  recognitionBinding?: {
    candidate: RecognitionCandidate;
    type: RecognitionType | null;
    targetModuleId: string | null;
    targetDatabaseId: string | null;
  };
  /**
   * For `pageContent` only; a `database` target is always the type's `targetDatabase`. A `journalEntry` target is
   * server-owned, so a result carrying one is refused.
   */
  target?: string;
  properties: Record<string, unknown>;
  relations?: Record<string, string[]>;
  /** Single-step `database` answers only; stored as `pageSections` and applied on confirm. */
  pageSections?: ProposalPageSection[];
  /** Single-step `database` answers only; a `properties` value references one as `{ newOption: "<label>" }`. */
  newOptions?: ProposalNewOption[];
  invalidProposal?: "workspaceReference" | "unrepresentableOperations";
  /**
   * Present only for more than one operation or an operation marked `primary`, which makes a multi-step envelope. A
   * single unmarked operation is returned as `properties`.
   */
  operations?: ProposalComputationOperation[];
  /** Trimmed and capped at 500 characters when stored. */
  reason?: string;
  confidence?: number;
}

/**
 * The injected model call that decides what an Inbox source becomes. It must never write to any target database or
 * page; it only computes values, and `createSemprecTickAction` alone writes the envelope.
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

/** Its form is checked with the rest of the envelope. */
function sourceItemDate(item: ItemRow): string | undefined {
  const date = item.properties.date;
  return typeof date === "string" ? date : undefined;
}

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

/** `date` defaults to the source item's date. A result with its own `target` is a `ValidationError`. */
function buildJournalEntryEnvelope(snapshot: TickSnapshot, result: ProposalComputationResult): ProposalEnvelope {
  if (result.target !== undefined)
    throw new ValidationError("The target of a journal entry proposal is set by the server", { field: "target" });
  if (!snapshot.journalDatabaseId)
    throw new Error(`Snapshot for Inbox item ${snapshot.item.id} (entityKind 'journalEntry') has no journalDatabaseId`);
  const date = result.properties.date === undefined ? sourceItemDate(snapshot.item) : result.properties.date;
  return {
    entityKind: "journalEntry",
    target: snapshot.journalDatabaseId,
    properties: {
      ...result.properties,
      ...(date === undefined ? {} : { date }),
    },
  };
}

/** Returns the refusal instead of throwing, so the write phase records it as `needsClarification`. */
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

/** Pure: no I/O. */
export function buildProposalEnvelope(snapshot: TickSnapshot, result: ProposalComputationResult): ProposalEnvelope {
  if (snapshot.entityKind === "journalEntry") return buildJournalEntryEnvelope(snapshot, result);
  if (snapshot.entityKind === "database") {
    if (!snapshot.targetDatabaseId)
      throw new Error(`Snapshot for Inbox item ${snapshot.item.id} (entityKind 'database') has no targetDatabaseId`);
    const operations = result.operations?.slice(0, MAX_PROPOSAL_OPERATIONS);
    // A marked operation is multi-step even alone: its primary step stands for the record.
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

/** Runs only after the source fingerprint is revalidated. */
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
