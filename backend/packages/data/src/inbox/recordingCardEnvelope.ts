import { z } from "zod";
import { ValidationError } from "../errors.js";
import type { InboxAttachmentSource } from "./inboxAttachmentsStore.js";

// The envelope and context of the `inbox` card that proposes transcribing an audio attachment: kind `transcription`,
// `target` the attachment row id.

export const RECORDING_ENTITY_KIND = "transcription";

/** The top of the `recording_requests` `integer` columns that store it. */
export const MAX_RECORDING_SPEAKERS = 2_147_483_647;

/** The values a user may edit on the card. */
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
 * A non-empty `name` plus optional parameters; `null` equals absent. `language` is ISO 639-1; `numSpeakersExact` (from
 * 1) and `numSpeakersMin` (from 2) are mutually exclusive and capped by the storing column. `noEvent: true` is an
 * explicit no-Event choice and is refused next to an `eventId`. Recording time and duration come from the attachment
 * metadata, so `recordedAt`/`durationSeconds` are unknown keys.
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

export interface RecordingCardProperties {
  name: string;
  language: string | null;
  numSpeakersExact: number | null;
  numSpeakersMin: number | null;
  eventId: string | null;
  projectId: string | null;
  /** True only when the user chose that the recording belongs to no Event. */
  noEvent: boolean;
}

/** Parses the `properties`; unknown keys, a blank `name` and out-of-domain values are a `ValidationError` on the field. */
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
 * A recording card's `context`, written only by the producer. `candidates` are suggested Events (empty when the day is
 * unknown); `recording` is what the attachment metadata knows (`durationSeconds`/`recordedAt` omitted when absent).
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
