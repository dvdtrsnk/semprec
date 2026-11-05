import { z } from "zod";
import type { AiGatewayCompletionInput } from "@semprec/shared";
import type { SpeakerMappingSuggestion, SpeakerSuggestionContext } from "@semprec/data";
import type { TranscriptSegment } from "./segmentMerge.js";

const SPEAKER_SUGGESTION_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    mappings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          speaker: { type: "string" },
          personId: { type: ["string", "null"] },
          reason: { type: "string", minLength: 1 },
        },
        required: ["speaker", "personId", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["mappings"],
  additionalProperties: false,
};

const speakerSuggestionResponseSchema = z.object({
  mappings: z.array(z.object({ speaker: z.string(), personId: z.string().nullable(), reason: z.string().min(1) })),
});

/**
 * The gateway request asks which eligible person each unmapped speaker is, using the supplied
 * candidate list and how speakers address each other in the transcript.
 */
export function buildSpeakerSuggestionRequest(
  segments: readonly TranscriptSegment[],
  context: SpeakerSuggestionContext,
): AiGatewayCompletionInput {
  const participants = context.candidates.map((candidate) => `${candidate.id}: ${candidate.name}`).join("\n");
  const transcript = segments.map((segment) => `${segment.speaker}: ${segment.text}`).join("\n");
  return {
    projectItemId: null,
    operation: "transcript_speaker_suggestion",
    temperature: 0,
    system:
      "You identify which meeting participant each anonymous speaker label in a transcript is. Use only the " +
      "participant list and how the speakers address or refer to each other in the transcript. Map a speaker " +
      "only when the transcript clearly supports it; otherwise use null for personId. Never map two speakers to the " +
      "same participant. Answer with participant ids exactly as listed, and give one short reason sentence " +
      `in the user's language (${context.locale}).`,
    messages: [
      {
        role: "user",
        content:
          `Speakers to identify:\n${context.unmappedSpeakers.join("\n")}\n\n` +
          `Participants (id: name):\n${participants}\n\nTranscript:\n${transcript}`,
      },
    ],
    responseSchema: SPEAKER_SUGGESTION_RESPONSE_SCHEMA,
  };
}

/** Validates the gateway's structured content: it crossed a process boundary, so it is checked, not cast. */
export function parseSpeakerSuggestionContent(content: unknown): SpeakerMappingSuggestion[] {
  return speakerSuggestionResponseSchema.parse(content).mappings;
}
