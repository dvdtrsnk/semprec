import { z } from "zod";

const edgeMetadataSchema = z.record(z.string(), z.unknown());

const edgeEndsSchema = z.object({
  relationPropertyId: z.string().uuid(),
  callerItemId: z.string().uuid(),
  targetItemId: z.string().uuid(),
});

/** An edge the confirmation wrote; `previousMetadata` is `null` when it inserted the edge, else the replaced metadata. */
export const writtenRelationSchema = edgeEndsSchema.extend({
  metadata: edgeMetadataSchema,
  previousMetadata: edgeMetadataSchema.nullable(),
});

/** An edge the confirmation deleted, with the metadata it had. */
export const removedRelationSchema = edgeEndsSchema.extend({ metadata: edgeMetadataSchema });

/** A Processing proposal's chat and decision log entry. */
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
  /** Set on a user's instruction to a transcript card, so a job can name the entry. */
  id: z.uuid().optional(),
  author: z.enum(["ai", "user"]),
  message: z.string(),
  at: z.string(),
  kind: z.enum(PROPOSAL_HISTORY_KINDS).optional(),
  keys: z.array(z.string()).optional(),
  threadId: z.string().optional(),
  messageId: z.string().optional(),
  /** On a `threadRevision` answering a transcript card instruction: that instruction entry's `id`. */
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
   * On a confirmation entry: edges between existing items it wrote. Present (maybe empty) whenever the confirmation
   * recorded its edges; absent on older entries.
   */
  writtenRelations: z.array(writtenRelationSchema).optional(),
  /** On a confirmation entry: the edges an update step deleted, with their metadata. */
  removedRelations: z.array(removedRelationSchema).optional(),
});

export type WrittenRelation = z.infer<typeof writtenRelationSchema>;
export type RemovedRelation = z.infer<typeof removedRelationSchema>;

export type ProposalHistoryEntry = z.infer<typeof proposalHistoryEntrySchema>;

/** Appends a history entry, treating a missing or malformed `history` as empty. `author` defaults to `'ai'`. */
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
