import { z } from "zod";

const uuid = z.uuid();

/** A calendar day as `YYYY-MM-DD`; a date that does not exist, such as `2026-02-30`, is refused. */
const calendarDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((day) => {
    const parsed = new Date(`${day}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(day);
  }, "Not a calendar day");

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

/**
 * A future occurrence of a repeating task that exists only as a computed day: named by its series and day, with no item
 * id (docs/adr/2026-10-25-task-and-event-recurrence-model.md). `seriesId` is any non-empty string here; only a series
 * of the caller's tenant makes a reference valid.
 */
const taskOccurrenceRefSchema = z.strictObject({
  kind: z.literal("taskOccurrence"),
  seriesId: z.string().min(1),
  occurrenceDate: calendarDay,
});

/** The trace of a task on a past day: the task item plus the day. */
const taskTraceRefSchema = z.strictObject({
  kind: z.literal("taskTrace"),
  itemId: uuid,
  databaseId: uuid,
  traceDay: calendarDay,
});

/**
 * One night of sleep, named by the calendar day of its evening: the plan of the wake day merged with an optional
 * exception is a computed value, not an item, so the ref carries no item id. It is virtual: no row has to exist for it.
 */
const sleepNightRefSchema = z.strictObject({
  kind: z.literal("sleepNight"),
  night: calendarDay,
});

/** Closed union of the objects a message sent to Semp can reference. */
export const sempMessageRefSchema = z.discriminatedUnion("kind", [
  itemRefSchema,
  blockRefSchema,
  transcriptSegmentRefSchema,
  mailAttachmentRefSchema,
  agentRunRefSchema,
  approvalRequestRefSchema,
  taskOccurrenceRefSchema,
  taskTraceRefSchema,
  sleepNightRefSchema,
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
  taskOccurrenceRefSchema.safeExtend({ label: z.string() }),
  taskTraceRefSchema.safeExtend({ label: z.string() }),
  sleepNightRefSchema.safeExtend({ label: z.string() }),
]);

export type LabeledSempMessageRef = z.infer<typeof labeledSempMessageRefSchema>;

/** Current display metadata; approval descriptions remain localizable templates. */
export interface SempApprovalDescription {
  key: string;
  params: Record<string, string | number | null>;
  endsInheritance?: Array<{ itemId: string; propertyKey: string; sourceName: string | null }>;
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
  "taskOccurrence",
  "taskTrace",
  "sleepNight",
] as const satisfies readonly SempMessageRef["kind"][];

/**
 * Dedup identity of a ref: the kind plus its id fields, the block id for
 * blocks, the range for segments and the night for a sleep night. `messageId`
 * of an agent run ref is not part of the identity.
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
    case "taskOccurrence":
      return `taskOccurrence:${ref.seriesId}:${ref.occurrenceDate}`;
    case "taskTrace":
      return `taskTrace:${ref.itemId}:${ref.databaseId}:${ref.traceDay}`;
    case "sleepNight":
      return `sleepNight:${ref.night}`;
  }
}
