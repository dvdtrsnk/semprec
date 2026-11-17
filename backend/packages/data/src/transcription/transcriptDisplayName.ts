import { instantToWallClock } from "../calendarTime.js";
import { renderTranscriptionLabel } from "./transcriptionLabels.js";

export interface TranscriptNameFacts {
  /** User-entered; the pipeline never writes it from a filename. */
  name: string | null | undefined;
  /** `null` without a live link. */
  eventName: string | null | undefined;
}

export function presentText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * The user's `name`; else the live linked Event's name, so an Event rename shows at once; else the
 * translated "Recording D. M. HH:MM" from `date` in tenant zone `zone` (an invalid zone throws).
 * Blank values count as absent; `null` only when all three are missing. The meeting-notes title is
 * not part of the chain: `resolveTranscriptSuggestedName` proposes it.
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
 * The meeting-notes title, only for a transcript with no user `name`, no live linked Event and a
 * non-blank title. Confirming it writes the user-owned `name`, after which this is `null`.
 */
export function resolveTranscriptSuggestedName(
  facts: TranscriptNameFacts & { generatedTitle: string | null | undefined },
): string | null {
  if (presentText(facts.name) !== null || presentText(facts.eventName) !== null) return null;
  return presentText(facts.generatedTitle);
}
