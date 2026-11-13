import { z } from "zod";

/**
 * The `context` of a `transcript` card that asks which of several overlapping Events a recording
 * belongs to (issue #1848). Only the producer writes it and clients read it; it carries no
 * transcript text beyond the one `quote`, chosen deterministically by `createTranscriptEventCard`.
 */
export const transcriptEventCardContextSchema = z.object({
  role: z.literal("event"),
  candidates: z
    .array(
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
    )
    .min(2),
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
