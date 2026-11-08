import { z } from "zod";
import type { AiGatewayCompletionInput } from "@semprec/shared";
import type { TranscriptSegment } from "./segmentMerge.js";

/**
 * The instruction step 5 generates for. `key` is the English camelCase computed key its result is
 * stored under on the Transcripts item; `prompt` is what the model is asked to do.
 */
export interface SummaryInstruction {
  key: string;
  prompt: string;
}

/** Issue #1695: structured meeting notes, stored as the Transcripts computed key `meetingNotes`. */
export const MEETING_NOTES_INSTRUCTION: SummaryInstruction = {
  key: "meetingNotes",
  prompt:
    "Write meeting notes for someone who did not attend: a short title, a summary of the main topics, a " +
    "one-sentence short summary, the decisions made and the action items. Refer to speakers only through " +
    "tokens in the form {SPEAKER_00}, using the speaker keys the transcript lines start with; never use a " +
    "name or a label of your own. For each action item, put its owner in ownerSpeaker as such a key without " +
    "braces (for example SPEAKER_01), or null when nobody owns it. Write due as YYYY-MM-DD, resolving a " +
    'relative date such as "tomorrow" from the recording date given below, or null when no due date is ' +
    "stated. Set startsAt to the second in the recording where the item is stated (each transcript line " +
    "starts with the second it begins at, in brackets), or null. Return empty lists when there are no " +
    "decisions or action items.",
};

/**
 * The `responseSchema` the gateway validates the model's notes against
 * (`services/semprec-ai-gateway/src/schemaValidation.ts`, Draft 2020-12): nullable fields are
 * `["string", "null"]`/`["number", "null"]`, and every field is required so the model states `null`.
 */
export const MEETING_NOTES_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    shortSummary: { type: "string" },
    decisions: { type: "array", items: { type: "string" } },
    actionItems: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          ownerSpeaker: { type: ["string", "null"] },
          due: { type: ["string", "null"] },
          startsAt: { type: ["number", "null"] },
        },
        required: ["text", "ownerSpeaker", "due", "startsAt"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "summary", "shortSummary", "decisions", "actionItems"],
  additionalProperties: false,
};

const meetingNotesContentSchema = z
  .object({
    title: z.string(),
    summary: z.string(),
    shortSummary: z.string(),
    decisions: z.array(z.string()),
    actionItems: z.array(
      z
        .object({
          text: z.string(),
          ownerSpeaker: z.string().nullable(),
          due: z.string().nullable(),
          startsAt: z.number().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

/** The notes as stored in `computed.meetingNotes`: the model's notes after `normalizeMeetingNotes`. */
export type MeetingNotes = z.infer<typeof meetingNotesContentSchema>;

/** The notes of a transcript without segments, stored without a paid call. */
export function emptyMeetingNotes(): MeetingNotes {
  return { title: "", summary: "", shortSummary: "", decisions: [], actionItems: [] };
}

/** The recording's calendar day in the tenant's time zone, with its English weekday name. */
export interface RecordingDay {
  date: string;
  weekday: string;
}

/**
 * The calendar day and weekday of the instant `recordedAt` (the UTC instant `Transcripts.date`
 * stores) in `timeZone`, or `null` when `recordedAt` is not a valid instant.
 */
export function recordingDay(recordedAt: string, timeZone: string): RecordingDay | null {
  const instant = new Date(recordedAt);
  if (Number.isNaN(instant.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";
  return { date: `${part("year")}-${part("month")}-${part("day")}`, weekday: part("weekday") };
}

/** One line per segment, `[startsAt] SPEAKER_00: text`, in recording order. */
function renderTranscript(segments: readonly TranscriptSegment[]): string {
  return segments.map((segment) => `[${segment.startsAt}] ${segment.speaker}: ${segment.text}`).join("\n");
}

/** The `gateway.complete()` request for the meeting notes of a merged transcript. */
export function buildMeetingNotesRequest(
  segments: readonly TranscriptSegment[],
  language: string | null,
  day: RecordingDay | null,
): AiGatewayCompletionInput {
  const languageRule = language
    ? `Write the notes in the transcript's language (${language}).`
    : "Write the notes in the language the transcript is in.";
  const dateLine = day ? `Recording date: ${day.date} (${day.weekday})` : "Recording date: unknown";
  return {
    projectItemId: null,
    operation: "transcript_summary",
    temperature: 0,
    system: `You write structured notes of meeting transcripts. Follow the instruction exactly. ${languageRule}`,
    messages: [
      {
        role: "user",
        content: `Instruction:\n${MEETING_NOTES_INSTRUCTION.prompt}\n\n${dateLine}\n\nTranscript:\n${renderTranscript(segments)}`,
      },
    ],
    responseSchema: MEETING_NOTES_RESPONSE_SCHEMA,
  };
}

/** Validates the gateway's structured content: it crossed a process boundary, so it is checked, not cast. */
export function parseMeetingNotesContent(content: unknown): MeetingNotes {
  return meetingNotesContentSchema.parse(content);
}

/** True for a `YYYY-MM-DD` string that names a real calendar date (`2026-02-30` does not). */
function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Normalizes the parsed notes before they are stored: an action item's `ownerSpeaker` is kept only
 * when it is a speaker key of `segments`, `due` only when it is a valid calendar date, `startsAt`
 * only when it is a finite number of at least 0; otherwise each is `null`. The validation checks the
 * shape of the date, it does not interpret natural language: resolving "tomorrow" is the model's job.
 */
export function normalizeMeetingNotes(notes: MeetingNotes, segments: readonly TranscriptSegment[]): MeetingNotes {
  const speakers = new Set(segments.map((segment) => segment.speaker));
  return {
    ...notes,
    actionItems: notes.actionItems.map((item) => ({
      text: item.text,
      ownerSpeaker: item.ownerSpeaker !== null && speakers.has(item.ownerSpeaker) ? item.ownerSpeaker : null,
      due: item.due !== null && isCalendarDate(item.due) ? item.due : null,
      startsAt: item.startsAt !== null && Number.isFinite(item.startsAt) && item.startsAt >= 0 ? item.startsAt : null,
    })),
  };
}
