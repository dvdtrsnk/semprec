import { z } from "zod";

/**
 * The `context` of a `transcript` card that asks which of several overlapping Events a recording
 * belongs to (issues #1848 and gh-1850): two or more stored Events, or at least one virtual occurrence. Only the producer writes it and clients read it; it carries no
 * transcript text beyond the one `quote`, chosen deterministically by `createTranscriptEventCard`.
 */
export const transcriptEventCardContextSchema = z.object({
  role: z.literal("event"),
  candidates: z
    .array(
      z.union([
        z.object({
          id: z.uuid(),
          name: z.string(),
          date: z.string(),
          timeFrom: z.string(),
          timeTo: z.string().nullable(),
          endDate: z.string().nullable(),
          projectId: z.uuid().nullable(),
          projectName: z.string().nullable(),
        }),
        // An occurrence of a recurring Event that has no item yet (issue gh-1850): it is materialized when the card is confirmed.
        z.strictObject({ seriesId: z.uuid(), occurrenceDate: z.string() }),
      ]),
    )
    .min(1),
  /** The model's one-sentence reason, or `null` when it gave none or its answer was not usable. */
  reason: z.string().min(1).nullable(),
  recommendedEventId: z.uuid().nullable(),
  recording: z.object({
    durationSeconds: z.number().nonnegative(),
    speakerCount: z.number().int().nonnegative(),
    quote: z.object({ segmentIndex: z.number().int().nonnegative(), text: z.string() }).nullable(),
  }),
});
export type TranscriptEventCardContext = z.infer<typeof transcriptEventCardContextSchema>;
