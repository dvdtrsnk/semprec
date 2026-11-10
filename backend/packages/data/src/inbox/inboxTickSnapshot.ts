import type { PoolClient } from "pg";
import { z } from "zod";
import { getItemsByIds } from "../chokePoint/itemsStore.js";
import { readPageSummary } from "../docs/pageSummary.js";
import type { ItemRow } from "../types.js";
import type { ProcessingMethod } from "./inboxTypesStore.js";
import type { RecognitionType, RecognitionCandidate } from "./inboxRecognition.js";
import type { ProposalEnvelope, ProposalEntityKind } from "./proposalEnvelope.js";
import {
  MAX_PROPOSAL_OPERATIONS,
  buildProposalSteps,
  type ProposalComputationOperation,
} from "./proposalOperations.js";
type ComputedProposalEntityKind = Exclude<ProposalEntityKind, "relation">;
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
  /** The language (the person's `users.locale`, e.g. `cs`) the proposal's person-facing texts must be written in. */
  locale: string;
  /** The project the heartbeat belongs to (`ActionContext.projectItemId`); the model call is attributed to it. */
  projectItemId: string;
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
  /** The target page id, for `entityKind: 'pageContent'` — ignored otherwise, since a `'database'` target is always the type's resolved `targetDatabase` id. */
  target?: string;
  properties: Record<string, unknown>;
  relations?: Record<string, string[]>;
  invalidProposal?: "workspaceReference" | "unrepresentableOperations";
  /**
   * Present only when the answer has more than one operation (at most `MAX_PROPOSAL_OPERATIONS`); then
   * `buildProposalEnvelope` stores a multi-step envelope. A single operation is returned as `properties`.
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
  existingProposal: ItemRow | null;
  fingerprint: string;
  locale: string;
}

/** Combines the external call's result with the snapshot into a stored envelope — no I/O. */
export function buildProposalEnvelope(snapshot: TickSnapshot, result: ProposalComputationResult): ProposalEnvelope {
  if (snapshot.entityKind === "database") {
    if (!snapshot.targetDatabaseId)
      throw new Error(`Snapshot for Inbox item ${snapshot.item.id} (entityKind 'database') has no targetDatabaseId`);
    const operations = result.operations?.slice(0, MAX_PROPOSAL_OPERATIONS);
    if (operations && operations.length > 1) {
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
