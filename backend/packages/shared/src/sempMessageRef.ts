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

/**
 * A mail thread by its public thread id (no client addresses its Threads item). Stored as given: a merged-away thread
 * resolves through its alias when the ref is read or expanded.
 */
const mailThreadRefSchema = z.strictObject({
  kind: z.literal("mailThread"),
  threadId: uuid,
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
 * A future occurrence of a repeating task that exists only as a computed day: series plus day, no item id. Only a
 * series of the caller's tenant makes the ref valid.
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
 * One night of sleep, named by the day of its evening. The wake day's plan merged with an optional exception is
 * computed, not an item, so no row has to exist.
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
  mailThreadRefSchema,
  agentRunRefSchema,
  approvalRequestRefSchema,
  taskOccurrenceRefSchema,
  taskTraceRefSchema,
  sleepNightRefSchema,
]);

export type SempMessageRef = z.infer<typeof sempMessageRefSchema>;

export const labeledSempMessageRefSchema = z.discriminatedUnion("kind", [
  itemRefSchema.safeExtend({ label: z.string() }),
  blockRefSchema.safeExtend({ label: z.string() }),
  transcriptSegmentRefSchema.safeExtend({ label: z.string() }),
  mailAttachmentRefSchema.safeExtend({ label: z.string() }),
  mailThreadRefSchema.safeExtend({ label: z.string() }),
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
  "mailThread",
  "agentRun",
  "approvalRequest",
  "taskOccurrence",
  "taskTrace",
  "sleepNight",
] as const satisfies readonly SempMessageRef["kind"][];

/**
 * Dedup identity of a ref: kind plus id fields, the block id for blocks, the range for segments, the night for a sleep
 * night. An agent run ref's `messageId` is part of it: a whole-run ref and each answer ref are distinct, and only the
 * same answer posted twice is a duplicate. A mail thread is keyed by the id as given, so a merged-away id and its
 * survivor's id are two refs.
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
    case "mailThread":
      return `mailThread:${ref.threadId}`;
    case "agentRun":
      return `agentRun:${ref.agentRunId}:${ref.messageId ?? ""}`;
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
