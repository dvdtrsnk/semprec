import { z } from "zod";

const uuid = z.uuid();

const itemRefSchema = z.strictObject({
  kind: z.literal("item"),
  itemId: uuid,
  databaseId: uuid,
});

const blockRefSchema = z.strictObject({
  kind: z.literal("block"),
  itemId: uuid,
  blockId: uuid,
});

const transcriptSegmentRefSchema = z
  .strictObject({
    kind: z.literal("transcriptSegment"),
    itemId: uuid,
    /** Seconds from the start of the recording. */
    startsAt: z.number().finite().nonnegative(),
    /** Seconds from the start of the recording; greater than `startsAt`. */
    endsAt: z.number().finite(),
  })
  .refine((ref) => ref.endsAt > ref.startsAt, {
    message: "endsAt must be greater than startsAt",
    path: ["endsAt"],
  });

const mailAttachmentRefSchema = z.strictObject({
  kind: z.literal("mailAttachment"),
  attachmentId: uuid,
});

const agentRunRefSchema = z.strictObject({
  kind: z.literal("agentRun"),
  agentRunId: uuid,
  messageId: uuid.optional(),
});

const approvalRequestRefSchema = z.strictObject({
  kind: z.literal("approvalRequest"),
  approvalRequestId: uuid,
});

/** Closed union of the objects a message sent to Semp can reference. */
export const sempMessageRefSchema = z.discriminatedUnion("kind", [
  itemRefSchema,
  blockRefSchema,
  transcriptSegmentRefSchema,
  mailAttachmentRefSchema,
  agentRunRefSchema,
  approvalRequestRefSchema,
]);

export type SempMessageRef = z.infer<typeof sempMessageRefSchema>;

/** A stored user-turn reference with the label captured when it was sent. */
export const labeledSempMessageRefSchema = z.discriminatedUnion("kind", [
  itemRefSchema.safeExtend({ label: z.string() }),
  blockRefSchema.safeExtend({ label: z.string() }),
  transcriptSegmentRefSchema.safeExtend({ label: z.string() }),
  mailAttachmentRefSchema.safeExtend({ label: z.string() }),
  agentRunRefSchema.safeExtend({ label: z.string() }),
  approvalRequestRefSchema.safeExtend({ label: z.string() }),
]);

export type LabeledSempMessageRef = z.infer<typeof labeledSempMessageRefSchema>;

/** Current display metadata; approval descriptions remain localizable templates. */
export interface SempApprovalDescription {
  key: string;
  params: Record<string, string | number | null>;
  endsInheritance?: Array<{ itemId: string; propertyKey: string; sourceName: string }>;
}

export type SempRefResolution = {
  label: string | SempApprovalDescription | null;
  databaseKey: string | null;
  state: "active" | "trashed" | "purged";
};

type StoredSempMessageRef = SempMessageRef | LabeledSempMessageRef;
export type ResolvedSempMessageRef =
  | (Exclude<StoredSempMessageRef, { kind: "approvalRequest" }> & {
      resolved: SempRefResolution & { label: string | null };
    })
  | (Extract<StoredSempMessageRef, { kind: "approvalRequest" }> & {
      resolved: SempRefResolution & { label: SempApprovalDescription | null };
    });

export const SEMP_MESSAGE_REF_KINDS = [
  "item",
  "block",
  "transcriptSegment",
  "mailAttachment",
  "agentRun",
  "approvalRequest",
] as const satisfies readonly SempMessageRef["kind"][];

/**
 * Dedup identity of a ref: the kind plus its id fields, the block id for
 * blocks and the range for segments. `messageId` of an agent run ref is not
 * part of the identity.
 */
export function messageRefKey(ref: SempMessageRef): string {
  switch (ref.kind) {
    case "item":
      return `item:${ref.itemId}:${ref.databaseId}`;
    case "block":
      return `block:${ref.itemId}:${ref.blockId}`;
    case "transcriptSegment":
      return `transcriptSegment:${ref.itemId}:${ref.startsAt}:${ref.endsAt}`;
    case "mailAttachment":
      return `mailAttachment:${ref.attachmentId}`;
    case "agentRun":
      return `agentRun:${ref.agentRunId}`;
    case "approvalRequest":
      return `approvalRequest:${ref.approvalRequestId}`;
  }
}
