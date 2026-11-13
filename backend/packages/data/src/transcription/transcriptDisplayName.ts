import { instantToWallClock } from "../calendarTime.js";
import { renderTranscriptionLabel } from "./transcriptionLabels.js";

/** What the name chain of a transcript reads (issue #1830). */
export interface TranscriptNameFacts {
  /** The user-entered `Transcripts.name`; the pipeline never writes it from a filename. */
  name: string | null | undefined;
  /** The name of the live Event the transcript is linked to; `null` without a live link. */
  eventName: string | null | undefined;
}

/** The text of `value` when it holds a non-blank string, otherwise `null`. */
export function presentText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * The title a user sees for a transcript, in this order: the user-entered `name`; the name of the live
 * linked Event, so a rename of the Event shows at once; otherwise the translated "Recording D. M. HH:MM"
 * (`transcript.displayName.recorded`) built from `date`, the recording's start as an instant, in the tenant
 * time zone `zone` and the language of `locale`; an invalid `zone` throws the `ValidationError` of
 * `instantToWallClock`. The same pattern serves a recording that is still processing,
 * an imported file and one made in the app. A blank `name` or `eventName` counts as absent. `null` only for a
 * transcript that has neither a name, a live Event nor a readable `date`. The meeting-notes title is not part
 * of the chain: `resolveTranscriptSuggestedName` returns it as a proposal.
 */
export async function resolveTranscriptDisplayName(
  facts: TranscriptNameFacts & { date: string | null | undefined },
  zone: string,
  locale: string,
): Promise<string | null> {
  const named = presentText(facts.name) ?? presentText(facts.eventName);
  if (named !== null) return named;
  const startedAt = typeof facts.date === "string" ? Date.parse(facts.date) : Number.NaN;
  if (!Number.isFinite(startedAt)) return null;
  const { date, time } = instantToWallClock(new Date(startedAt), zone);
  const [, month, day] = date.split("-").map(Number);
  return renderTranscriptionLabel(locale, "transcript.displayName.recorded", {
    day: day ?? 0,
    month: month ?? 0,
    time,
  });
}

/**
 * The name Semp proposes for a transcript: `generatedTitle` (the meeting notes' title, speaker tokens
 * already replaced) when the transcript has no user-entered `name`, no live linked Event and the title is
 * not blank, otherwise `null`. Confirming it writes the user-owned `name` through the item update, after
 * which this is `null` and the display name is that name.
 */
export function resolveTranscriptSuggestedName(
  facts: TranscriptNameFacts & { generatedTitle: string | null | undefined },
): string | null {
  if (presentText(facts.name) !== null || presentText(facts.eventName) !== null) return null;
  return presentText(facts.generatedTitle);
}
