import { z } from "zod";
import type { AiGatewayCompletionInput } from "@semprec/shared";
import type { EventRecommendation, EventRecommendationContext } from "@semprec/data";

const EVENT_RECOMMENDATION_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    eventId: { type: ["string", "null"] },
    reason: { type: "string" },
  },
  required: ["eventId", "reason"],
  additionalProperties: false,
};

const eventRecommendationSchema = z.object({ eventId: z.string().nullable(), reason: z.string() });

type RecommendationCandidate = EventRecommendationContext["candidates"][number];

function describeCandidate(candidate: RecommendationCandidate): string {
  const dates = candidate.endDate === null ? candidate.date : `${candidate.date} to ${candidate.endDate}`;
  const times = candidate.timeTo === null ? candidate.timeFrom : `${candidate.timeFrom}-${candidate.timeTo}`;
  return [
    `- id: ${candidate.id}`,
    `  name: ${candidate.name}`,
    `  date: ${dates}`,
    `  times: ${times}`,
    `  project: ${candidate.projectName ?? "none"}`,
    `  participants: ${candidate.participantNames.length > 0 ? candidate.participantNames.join(", ") : "none"}`,
  ].join("\n");
}

/**
 * The gateway request asks which of the Events that overlapped a recording it belongs to, judging
 * by the recording's meeting notes (title, summary and short summary, speaker tokens already
 * replaced). The model answers with a candidate's id, or `null` when it cannot tell, and gives one
 * short reason sentence in the user's language (`locale`).
 */
export function buildEventRecommendationRequest(
  notes: EventRecommendationContext["notes"],
  candidates: readonly RecommendationCandidate[],
  locale: string,
): AiGatewayCompletionInput {
  return {
    projectItemId: null,
    operation: "transcript_event_match",
    temperature: 0,
    system:
      "You decide which calendar Event a recorded meeting belongs to. Several Events overlapped the recording in " +
      "time. Judge only by the meeting notes and the Events listed: their names, projects and participants. " +
      "Answer with the id of one listed Event, exactly as written. When the notes do not make clear which Event it " +
      "was, answer with null for eventId. Give one short reason sentence " +
      `in the user's language (${locale}).`,
    messages: [
      {
        role: "user",
        content:
          `Meeting notes:\nTitle: ${notes.title}\nSummary: ${notes.summary}\nShort summary: ${notes.shortSummary}\n\n` +
          `Events that overlapped the recording:\n${candidates.map(describeCandidate).join("\n")}`,
      },
    ],
    responseSchema: EVENT_RECOMMENDATION_RESPONSE_SCHEMA,
  };
}

/**
 * Validates the gateway's structured content: it crossed a process boundary, so it is checked, not
 * cast. Whether `eventId` is one of the candidates is decided later, where the card is created.
 */
export function parseEventRecommendationContent(content: unknown): EventRecommendation {
  return eventRecommendationSchema.parse(content);
}
