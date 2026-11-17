import { z } from "zod";

/**
 * Context of a `transcript` card asking which of several overlapping Events a recording belongs to
 * (two or more stored Events, or at least one virtual occurrence). Written only by the producer; it
 * carries no transcript text beyond the one `quote`, chosen deterministically.
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
        // A recurring Event's occurrence with no item yet; it is materialized when the card is confirmed.
        z.strictObject({ seriesId: z.uuid(), occurrenceDate: z.string() }),
      ]),
    )
    .min(1),
  /** `null` when the model gave none or its answer was not usable. */
  reason: z.string().min(1).nullable(),
  recommendedEventId: z.uuid().nullable(),
  recording: z.object({
    durationSeconds: z.number().nonnegative(),
    speakerCount: z.number().int().nonnegative(),
    quote: z.object({ segmentIndex: z.number().int().nonnegative(), text: z.string() }).nullable(),
  }),
});
export type TranscriptEventCardContext = z.infer<typeof transcriptEventCardContextSchema>;
