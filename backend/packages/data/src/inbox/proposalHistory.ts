import { z } from "zod";

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
});

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
    "id" | "kind" | "keys" | "threadId" | "messageId" | "instructionEntryId" | "addedRelations"
  >,
): ProposalHistoryEntry[] {
  const parsed = z.array(proposalHistoryEntrySchema).safeParse(history);
  const existing = parsed.success ? parsed.data : [];
  return [...existing, { author, message, at: new Date().toISOString(), ...extra }];
}
