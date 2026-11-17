import { z } from "zod";

export const transcriptSpeakerCardContextSchema = z.object({
  role: z.literal("speaker"),
  speaker: z.string().min(1),
  ordinal: z.number().int().positive(),
  quotes: z.array(z.object({ segmentIndex: z.number().int().nonnegative(), text: z.string() })).max(3),
  firstStartsAt: z.number(),
  source: z.object({ transcriptName: z.string().nullable(), date: z.string().nullable() }),
  reason: z.string().min(1),
  alternatives: z.array(
    z.object({
      personId: z.uuid(),
      name: z.string(),
      title: z.string().nullable(),
      invitationStatus: z.enum(["pending", "accepted", "tentative", "declined"]).nullable(),
    }),
  ),
});
export type TranscriptSpeakerCardContext = z.infer<typeof transcriptSpeakerCardContextSchema>;
