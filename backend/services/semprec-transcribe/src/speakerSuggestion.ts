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
        properties: { speaker: { type: "string" }, personId: { type: "string" } },
        required: ["speaker", "personId"],
        additionalProperties: false,
      },
    },
  },
  required: ["mappings"],
  additionalProperties: false,
};

const speakerSuggestionResponseSchema = z.object({
  mappings: z.array(z.object({ speaker: z.string(), personId: z.string() })),
});

/**
 * The `gateway.complete()` request that asks which of the Event's participants each unmapped
 * speaker key is (issue #185): only from the participant list and the ways speakers address each
 * other in the transcript, and only where the transcript actually supports it.
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
      "only when the transcript clearly supports it; leave it out otherwise. Never map two speakers to the " +
      "same participant. Answer with participant ids exactly as listed.",
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
