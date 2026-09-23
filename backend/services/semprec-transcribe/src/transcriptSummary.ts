import { z } from "zod";
import type { AiGatewayCompletionInput } from "@semprec/shared";
import type { TranscriptSegment } from "./segmentMerge.js";

/**
 * The instruction a summary is generated for. `key` is the English camelCase key its summary is
 * cached under in `computed.summaryByInstruction`; `prompt` is what the model is asked to do.
 */
export interface SummaryInstruction {
  key: string;
  prompt: string;
}

/** The instruction the pipeline's step 5 summarizes every new transcript with. */
export const DEFAULT_SUMMARY_INSTRUCTION: SummaryInstruction = {
  key: "meetingSummary",
  prompt:
    "Summarize this meeting for someone who did not attend: the main topics discussed, the decisions made, " +
    "and the action items with their owners where the transcript names them. Refer to speakers by their " +
    "transcript labels.",
};

const SUMMARY_RESPONSE_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
  additionalProperties: false,
};

const summaryResponseSchema = z.object({ summary: z.string() });

/** One line per segment, `SPEAKER_00: text`, in recording order. */
function renderTranscript(segments: readonly TranscriptSegment[]): string {
  return segments.map((segment) => `${segment.speaker}: ${segment.text}`).join("\n");
}

/** The `gateway.complete()` request for one instruction over a merged transcript. */
export function buildSummaryRequest(
  segments: readonly TranscriptSegment[],
  language: string | null,
  instruction: SummaryInstruction,
): AiGatewayCompletionInput {
  const languageRule = language
    ? `Write the summary in the transcript's language (${language}).`
    : "Write the summary in the language the transcript is in.";
  return {
    projectItemId: null,
    operation: "transcript_summary",
    temperature: 0,
    system: `You summarize meeting transcripts. Follow the instruction exactly. ${languageRule}`,
    messages: [
      { role: "user", content: `Instruction:\n${instruction.prompt}\n\nTranscript:\n${renderTranscript(segments)}` },
    ],
    responseSchema: SUMMARY_RESPONSE_SCHEMA,
  };
}

/** Validates the gateway's structured content: it crossed a process boundary, so it is checked, not cast. */
export function parseSummaryContent(content: unknown): string {
  return summaryResponseSchema.parse(content).summary;
}
