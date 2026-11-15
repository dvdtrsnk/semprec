import { z } from "zod";
import { ValidationError } from "../errors.js";
import type { InboxAttachmentSource } from "./inboxAttachmentsStore.js";

// The envelope and the context of the card that proposes transcribing an audio attachment of an Inbox item
// (issue gh-1978). The card is an `inbox` card; its envelope kind is `transcription`, its `target` the id of the
// attachment row. The producer is `recordingCardProducer.ts`, the validation `recordingCardValidation.ts` and the
// confirm `recordingCardConfirm.ts`; the decision is in
// docs/adr/2026-11-14-inbox-recording-cards-confirm-into-recording-intake.md.

/** The `entityKind` of a recording card's envelope. */
export const RECORDING_ENTITY_KIND = "transcription";

/** The largest speaker count a card may hold: the top of the `integer` columns of `recording_requests` that store it. */
export const MAX_RECORDING_SPEAKERS = 2_147_483_647;

/** The keys a recording card's envelope `properties` may hold; the values a user may edit on the card. */
export const RECORDING_PROPERTY_KEYS: readonly string[] = [
  "name",
  "language",
  "numSpeakersExact",
  "numSpeakersMin",
  "eventId",
  "projectId",
  "noEvent",
];

/**
 * A recording card's envelope `properties`: a non-empty `name`, and the optional parameters of the recording. A
 * parameter the user cleared is `null`, which means the same as an absent one. `language` is an ISO 639-1 code,
 * `numSpeakersExact` an integer from 1 and `numSpeakersMin` an integer from 2, both at most `MAX_RECORDING_SPEAKERS`
 * (the width of the columns that store them), and at most one of the two holds a value. `noEvent` is the user's explicit
 * choice that the recording belongs to no Event (issue gh-1986): `true` is the choice, `false`, `null` and an absent
 * property mean that nothing was chosen, and `true` next to an `eventId` is refused. The recording time and the duration are not properties: they come from the attachment's metadata, so a
 * client-supplied `recordedAt` or `durationSeconds` is an unknown key.
 */
const recordingPropertiesSchema = z
  .strictObject({
    name: z.string().refine((value) => value.trim().length > 0, "must not be empty"),
    language: z
      .string()
      .regex(/^[a-z]{2}$/, "must be an ISO 639-1 code")
      .nullish(),
    numSpeakersExact: z.number().int().min(1).max(MAX_RECORDING_SPEAKERS).nullish(),
    numSpeakersMin: z.number().int().min(2).max(MAX_RECORDING_SPEAKERS).nullish(),
    eventId: z.uuid().nullish(),
    projectId: z.uuid().nullish(),
    noEvent: z.boolean().nullish(),
  })
  .refine((value) => value.numSpeakersExact == null || value.numSpeakersMin == null, {
    message: "at most one of numSpeakersExact and numSpeakersMin may be set",
    path: ["numSpeakersMin"],
  })
  .refine((value) => value.noEvent !== true || value.eventId == null, {
    message: "must not be true together with an eventId",
    path: ["noEvent"],
  });

/** The validated parameters of a recording card, each optional one `null` when it is not set. */
export interface RecordingCardProperties {
  name: string;
  language: string | null;
  numSpeakersExact: number | null;
  numSpeakersMin: number | null;
  eventId: string | null;
  projectId: string | null;
  /** True only when the user chose that the recording belongs to no Event; false for everything else. */
  noEvent: boolean;
}

/**
 * Parses a recording card envelope's `properties`. An unknown key (`recordedAt` and `durationSeconds` included), a
 * missing or blank `name` and a value out of its domain are a `ValidationError` naming the field.
 */
export function parseRecordingCardProperties(properties: Record<string, unknown>): RecordingCardProperties {
  const parsed = recordingPropertiesSchema.safeParse(properties);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.code === "unrecognized_keys" ? (issue.keys[0] ?? "properties") : String(issue?.path[0] ?? "");
    throw new ValidationError(
      `A recording proposal's property '${field || "properties"}' is invalid (${issue?.message ?? "invalid"})`,
      { field: field || "properties" },
    );
  }
  const value = parsed.data;
  return {
    name: value.name,
    language: value.language ?? null,
    numSpeakersExact: value.numSpeakersExact ?? null,
    numSpeakersMin: value.numSpeakersMin ?? null,
    eventId: value.eventId ?? null,
    projectId: value.projectId ?? null,
    noEvent: value.noEvent === true,
  };
}

/**
 * The `context` of a recording card (the card-state property of issue gh-1451, role `recording`). Only the producer
 * writes it and clients read it. `candidates` are the Events the card suggests (empty when the recording day is
 * unknown or no Event fits), `recording` is what the attachment's metadata knows before the transcription:
 * `durationSeconds` and `recordedAt` are omitted when the metadata has none, and `source` is where the attachment came
 * from.
 */
export const recordingCardContextSchema = z.object({
  role: z.literal("recording"),
  candidates: z.array(
    z.object({
      eventId: z.uuid(),
      name: z.string(),
      date: z.string(),
      timeFrom: z.string().nullable(),
      timeTo: z.string().nullable(),
      endDate: z.string().nullable(),
      projectId: z.uuid().nullable(),
      projectName: z.string().nullable(),
    }),
  ),
  recording: z.object({
    durationSeconds: z.number().nonnegative().optional(),
    recordedAt: z.string().optional(),
    source: z.enum([
      "camera",
      "scan",
      "photoLibrary",
      "files",
      "share",
    ] as const satisfies readonly InboxAttachmentSource[]),
  }),
});
export type RecordingCardContext = z.infer<typeof recordingCardContextSchema>;
