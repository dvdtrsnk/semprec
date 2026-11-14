import { z } from "zod";

const edgeMetadataSchema = z.record(z.string(), z.unknown());

const edgeEndsSchema = z.object({
  relationPropertyId: z.string().uuid(),
  callerItemId: z.string().uuid(),
  targetItemId: z.string().uuid(),
});

/**
 * An edge the confirmation wrote: `metadata` is what the edge held right after the write, `previousMetadata` is `null`
 * when the confirmation inserted the edge and the metadata the edge already had when the write replaced it.
 */
export const writtenRelationSchema = edgeEndsSchema.extend({
  metadata: edgeMetadataSchema,
  previousMetadata: edgeMetadataSchema.nullable(),
});

/** An edge the confirmation deleted, with the metadata it had. */
export const removedRelationSchema = edgeEndsSchema.extend({ metadata: edgeMetadataSchema });

/** A Processing proposal's chat + decision log entry (issue #104). */
const PROPOSAL_HISTORY_KINDS = [
  "computed",
  "userEdit",
  "reset",
  "typeChosen",
  "threadRevision",
  "recompute",
  "confirmed",
  "rejected",
  "reopened",
  "invalidated",
] as const;

export type ProposalHistoryKind = (typeof PROPOSAL_HISTORY_KINDS)[number];

export const proposalHistoryEntrySchema = z.object({
  /** The entry's own id, set on a user's instruction to a transcript card (issue gh-1940) so a job can name it. */
  id: z.uuid().optional(),
  author: z.enum(["ai", "user"]),
  message: z.string(),
  at: z.string(),
  kind: z.enum(PROPOSAL_HISTORY_KINDS).optional(),
  /** `ref.key` strings a `userEdit` entry touched. */
  keys: z.array(z.string()).optional(),
  threadId: z.string().optional(),
  messageId: z.string().optional(),
  /** On a `threadRevision` entry that answers an instruction to a transcript card: the `id` of that instruction's entry. */
  instructionEntryId: z.uuid().optional(),
  addedRelations: z
    .array(
      z.object({
        edgeId: z.string().uuid(),
        relationPropertyId: z.string().uuid(),
        callerItemId: z.string().uuid(),
        targetItemId: z.string().uuid(),
      }),
    )
    .optional(),
  /**
   * On the entry of a confirmation: every edge between items that already existed which the confirmation wrote (link steps, the
   * edges an update step added, the edge of a transcript card), recorded as `writtenRelationSchema` says. Present, even
   * as an empty array, on every entry written by a confirmation that records its edges; absent on one written before.
   */
  writtenRelations: z.array(writtenRelationSchema).optional(),
  /** On the entry of a confirmation: the edges an update step of the confirmation deleted, with the metadata they had. */
  removedRelations: z.array(removedRelationSchema).optional(),
});

export type WrittenRelation = z.infer<typeof writtenRelationSchema>;
export type RemovedRelation = z.infer<typeof removedRelationSchema>;

export type ProposalHistoryEntry = z.infer<typeof proposalHistoryEntrySchema>;

/**
 * Appends one history entry to a proposal's `history`, tolerating a missing/malformed
 * stored value as empty. Defaults to `author: 'ai'` for the tick's own entries (`inboxTickAction.ts`);
 * inbox/proposalActions.ts (issue #105) reuses this with `author: 'user'` for
 * confirm/reject/revise's own log entries.
 */
export function appendHistoryEntry(
  history: unknown,
  message: string,
  author: "ai" | "user" = "ai",
  extra?: Pick<
    ProposalHistoryEntry,
    | "id"
    | "kind"
    | "keys"
    | "threadId"
    | "messageId"
    | "instructionEntryId"
    | "addedRelations"
    | "writtenRelations"
    | "removedRelations"
  >,
): ProposalHistoryEntry[] {
  const parsed = z.array(proposalHistoryEntrySchema).safeParse(history);
  const existing = parsed.success ? parsed.data : [];
  return [...existing, { author, message, at: new Date().toISOString(), ...extra }];
}
