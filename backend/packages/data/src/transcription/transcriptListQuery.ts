import { z } from "zod";
import type { Queryable } from "../db/pool.js";
import { ITEM_AUTOMATION_ERROR_CODES, ITEM_AUTOMATION_STATUSES } from "../library/itemAutomationStore.js";
import { parseStoredMeetingNotes, renderMeetingNotes } from "./meetingNotesRendering.js";
import type { TranscriptSpeaker } from "./transcriptionSpeakerEdges.js";

export const TRANSCRIPT_PAIRINGS = ["processing", "event", "awaitingEvent", "none"] as const;
export type TranscriptPairing = (typeof TRANSCRIPT_PAIRINGS)[number];

export interface TranscriptListFilters {
  eventId: string | null;
  /** A speaker (`speakers`) or a participant (`people`) of the transcript (issue #1581). */
  personId: string | null;
  /** The transcript's `project` (issue #1581). */
  projectId: string | null;
  pairing: TranscriptPairing | null;
}

/** A page position: the last row's sort date (UTC, microseconds; `null` for an undated row) and id. */
export interface TranscriptListCursor {
  at: string | null;
  id: string;
}

const rowSchema = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  date: z.string().nullable(),
  sortAt: z.string().nullable(),
  durationSeconds: z.number().nullable(),
  status: z.enum(["recording", "processing", "done", "error"]).nullable(),
  pairing: z.enum(TRANSCRIPT_PAIRINGS),
  event: z.object({ id: z.uuid(), name: z.string().nullable() }).nullable(),
  proposalId: z.uuid().nullable(),
  questions: z.array(z.object({ proposalId: z.uuid(), speaker: z.string() })),
  speakerKeys: z.array(z.string()).nullable(),
  meetingNotes: z.unknown(),
  mappedSpeakers: z
    .array(z.object({ speaker: z.string(), personId: z.uuid(), name: z.string().nullable() }))
    .nullable(),
  automation: z
    .object({
      status: z.enum(ITEM_AUTOMATION_STATUSES),
      attempts: z.number().int(),
      lastAttemptAt: z.string().nullable(),
      errorCode: z.enum(ITEM_AUTOMATION_ERROR_CODES).nullable(),
    })
    .nullable(),
});

/**
 * `GET /api/transcripts` (issue #1636) as one SQL statement over `items`, `item_relations`,
 * `item_automation` and the Processing proposals database. Every relation endpoint counts only when
 * it is a live item of the expected database, so an unknown, foreign or trashed filter target
 * yields an empty list.
 *
 * Pairing, in this precedence: `processing` while `status` is `processing`; `none` while it is
 * `error`; `event` when the `event` edge targets a live Event; `awaitingEvent` (with that card's
 * `proposalId`, the oldest by `created_at` then id) when a `transcript` card in `proposed` or
 * `needsClarification` links the transcript through `sourceTranscript` and carries a `database`
 * envelope on Events or a `relation` envelope on `event`; otherwise `none`. A rejected card is in
 * neither status, so it pairs nothing. The open questions are the transcript's speaker cards in those
 * statuses: a `relation` envelope on `speakers` (its metadata names the speaker) or a `speaker`
 * context; the speaker keys of the segments, in first-appearance order, are read only for a
 * transcript that has one, to number them. `segments` itself is never returned.
 *
 * Order: by recording `date`, descending by default (`asc` on request), then id in the same
 * direction; an undated transcript sorts after every dated one in both directions. The keyset
 * cursor is the last row's `(date, id)`. `limit + 1` rows are read so the caller can tell whether
 * another page follows.
 */
export async function listTranscriptsPage(
  client: Queryable,
  input: {
    limit: number;
    order: "asc" | "desc";
    cursor: TranscriptListCursor | null;
    filters: TranscriptListFilters;
    /** The reader's locale, for the speaker labels of the rendered notes text. */
    locale: string;
  },
) {
  // `direction` and `after` come from the closed union `input.order`, never from request text.
  const direction = input.order === "asc" ? "ASC" : "DESC";
  const after = input.order === "asc" ? ">" : "<";
  const result = await client.query<{ row: unknown }>(
    `
WITH schema_ids AS (
  SELECT (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'transcripts') AS transcripts,
         (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'events') AS events,
         (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'people') AS people,
         (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'projects') AS projects,
         (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND system AND owner_module_id = 'processingProposals') AS proposals
), transcript_relation AS (
  SELECT p.key, rd.id, rd.property_id_a = p.id AS transcript_is_a
  FROM properties p JOIN relation_definitions rd ON rd.tenant_id = p.tenant_id AND p.id IN (rd.property_id_a, rd.property_id_b)
  WHERE p.tenant_id = app_tenant_default() AND p.database_id = (SELECT transcripts FROM schema_ids)
    AND p.key IN ('event', 'speakers', 'people', 'project')
), source_relation AS (
  SELECT rd.id, rd.property_id_a = p.id AS card_is_a
  FROM properties p JOIN relation_definitions rd ON rd.tenant_id = p.tenant_id AND p.id IN (rd.property_id_a, rd.property_id_b)
  WHERE p.tenant_id = app_tenant_default() AND p.database_id = (SELECT proposals FROM schema_ids) AND p.key = 'sourceTranscript'
), linked AS (
  -- Every live endpoint of a transcript's event, speakers, people and project edges.
  SELECT tr.key, CASE WHEN tr.transcript_is_a THEN r.item_a ELSE r.item_b END AS transcript_id, target.id AS target_id,
    target.properties AS target_properties, r.metadata
  FROM transcript_relation tr
  JOIN item_relations r ON r.tenant_id = app_tenant_default() AND r.relation_definition_id = tr.id
  JOIN items target ON target.tenant_id = app_tenant_default()
    AND target.id = CASE WHEN tr.transcript_is_a THEN r.item_b ELSE r.item_a END
    AND target.database_id = CASE tr.key WHEN 'event' THEN (SELECT events FROM schema_ids)
      WHEN 'project' THEN (SELECT projects FROM schema_ids) ELSE (SELECT people FROM schema_ids) END
    AND target.deleted_at IS NULL
), cards AS (
  SELECT CASE WHEN sr.card_is_a THEN r.item_b ELSE r.item_a END AS transcript_id, card.id, card.created_at, card.properties
  FROM source_relation sr
  JOIN item_relations r ON r.tenant_id = app_tenant_default() AND r.relation_definition_id = sr.id
  JOIN items card ON card.tenant_id = app_tenant_default() AND card.database_id = (SELECT proposals FROM schema_ids)
    AND card.id = CASE WHEN sr.card_is_a THEN r.item_a ELSE r.item_b END AND card.deleted_at IS NULL
  WHERE card.properties->>'kind' = 'transcript' AND card.properties->>'status' IN ('proposed', 'needsClarification')
), base AS (
  SELECT t.id, t.properties, t.computed, NULLIF(t.properties->>'date', '')::timestamptz AS sort_at
  FROM items t
  WHERE t.tenant_id = app_tenant_default() AND t.database_id = (SELECT transcripts FROM schema_ids) AND t.deleted_at IS NULL
    AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM linked l WHERE l.key = 'event' AND l.transcript_id = t.id AND l.target_id = $4::uuid))
    AND ($5::uuid IS NULL OR EXISTS (SELECT 1 FROM linked l WHERE l.key IN ('speakers', 'people') AND l.transcript_id = t.id AND l.target_id = $5::uuid))
    AND ($7::uuid IS NULL OR EXISTS (SELECT 1 FROM linked l WHERE l.key = 'project' AND l.transcript_id = t.id AND l.target_id = $7::uuid))
), paired AS (
  SELECT b.*, event.id AS event_id, event.name AS event_name, awaiting.id AS awaiting_id,
    CASE WHEN b.properties->>'status' = 'processing' THEN 'processing'
         WHEN b.properties->>'status' = 'error' THEN 'none'
         WHEN event.id IS NOT NULL THEN 'event'
         WHEN awaiting.id IS NOT NULL THEN 'awaitingEvent'
         ELSE 'none' END AS pairing
  FROM base b
  LEFT JOIN LATERAL (
    SELECT l.target_id AS id, CASE WHEN jsonb_typeof(l.target_properties->'name') = 'string' THEN l.target_properties->>'name' END AS name
    FROM linked l WHERE l.key = 'event' AND l.transcript_id = b.id ORDER BY l.target_id LIMIT 1
  ) event ON true
  LEFT JOIN LATERAL (
    SELECT c.id FROM cards c
    WHERE c.transcript_id = b.id AND (
      (c.properties->'proposal'->>'entityKind' = 'database' AND c.properties->'proposal'->>'target' = (SELECT events FROM schema_ids)::text)
      OR (c.properties->'proposal'->>'entityKind' = 'relation' AND c.properties->'proposal'->'properties'->>'propertyKey' = 'event'))
    ORDER BY c.created_at, c.id LIMIT 1
  ) awaiting ON true
), page AS (
  SELECT * FROM paired p
  WHERE ($6::text IS NULL OR p.pairing = $6::text)
    AND ($2::uuid IS NULL
      OR ($1::timestamptz IS NOT NULL AND (p.sort_at ${after} $1::timestamptz OR (p.sort_at = $1::timestamptz AND p.id ${after} $2::uuid) OR p.sort_at IS NULL))
      OR ($1::timestamptz IS NULL AND p.sort_at IS NULL AND p.id ${after} $2::uuid))
  ORDER BY p.sort_at IS NULL, p.sort_at ${direction}, p.id ${direction}
  LIMIT $3
)
SELECT jsonb_build_object(
  'id', p.id,
  'name', CASE WHEN jsonb_typeof(p.properties->'name') = 'string' THEN p.properties->>'name' END,
  'date', CASE WHEN jsonb_typeof(p.properties->'date') = 'string' THEN p.properties->>'date' END,
  'sortAt', to_char(p.sort_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'durationSeconds', CASE WHEN jsonb_typeof(p.computed->'durationSeconds') = 'number' THEN p.computed->'durationSeconds' END,
  'status', CASE WHEN jsonb_typeof(p.properties->'status') = 'string' THEN p.properties->>'status' END,
  'pairing', p.pairing,
  'event', CASE WHEN p.event_id IS NULL THEN NULL ELSE jsonb_build_object('id', p.event_id, 'name', p.event_name) END,
  'proposalId', CASE WHEN p.pairing = 'awaitingEvent' THEN p.awaiting_id END,
  'questions', COALESCE(questions.value, '[]'::jsonb),
  'meetingNotes', p.computed->'meetingNotes',
  'mappedSpeakers', CASE WHEN p.computed ? 'meetingNotes' THEN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('speaker', l.metadata->>'speaker', 'personId', l.target_id,
      'name', CASE WHEN jsonb_typeof(l.target_properties->'name') = 'string' THEN l.target_properties->>'name' END)
      ORDER BY l.target_id), '[]'::jsonb)
    FROM linked l WHERE l.key = 'speakers' AND l.transcript_id = p.id AND jsonb_typeof(l.metadata->'speaker') = 'string') END,
  'speakerKeys', CASE WHEN questions.value IS NOT NULL OR p.computed ? 'meetingNotes' THEN (
    SELECT COALESCE(jsonb_agg(s.speaker ORDER BY s.first), '[]'::jsonb)
    FROM (SELECT segment.value->>'speaker' AS speaker, min(segment.ordinality) AS first
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.computed->'segments') = 'array' THEN p.computed->'segments' ELSE '[]'::jsonb END)
            WITH ORDINALITY segment(value, ordinality)
          WHERE jsonb_typeof(segment.value->'speaker') = 'string'
          GROUP BY 1) s) END,
  'automation', CASE WHEN a.item_id IS NULL THEN NULL ELSE jsonb_build_object(
    'status', a.status, 'attempts', a.attempts,
    'lastAttemptAt', to_char(a.last_attempt_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'errorCode', a.error_code) END
) AS row
FROM page p
LEFT JOIN item_automation a ON a.tenant_id = app_tenant_default() AND a.item_id = p.id
LEFT JOIN LATERAL (
  SELECT jsonb_agg(jsonb_build_object('proposalId', q.id, 'speaker', q.speaker) ORDER BY q.id) AS value
  FROM (
    SELECT c.id, CASE
      WHEN c.properties->'proposal'->>'entityKind' = 'relation' AND c.properties->'proposal'->'properties'->>'propertyKey' = 'speakers'
        THEN c.properties->'proposal'->'properties'->'metadata'->>'speaker'
      WHEN c.properties->'context'->>'role' = 'speaker' THEN c.properties->'context'->>'speaker' END AS speaker
    FROM cards c WHERE c.transcript_id = p.id
  ) q WHERE q.speaker IS NOT NULL
) questions ON true
ORDER BY p.sort_at IS NULL, p.sort_at ${direction}, p.id ${direction}
`,
    [
      input.cursor?.at ?? null,
      input.cursor?.id ?? null,
      input.limit + 1,
      input.filters.eventId,
      input.filters.personId,
      input.filters.pairing,
      input.filters.projectId,
    ],
  );
  const rows = result.rows.map((row) => rowSchema.parse(row.row));
  return Promise.all(
    rows.map(async (parsed) => {
      const keys = parsed.speakerKeys ?? [];
      const questions = parsed.questions
        .map((question) => {
          const index = keys.indexOf(question.speaker);
          return { proposalId: question.proposalId, speaker: question.speaker, ordinal: index < 0 ? null : index + 1 };
        })
        .sort(
          (left, right) =>
            (left.ordinal ?? Number.MAX_SAFE_INTEGER) - (right.ordinal ?? Number.MAX_SAFE_INTEGER) ||
            (left.proposalId < right.proposalId ? -1 : left.proposalId > right.proposalId ? 1 : 0),
        );
      return {
        cursor: { at: parsed.sortAt, id: parsed.id },
        transcript: {
          id: parsed.id,
          displayName: parsed.name,
          date: parsed.date,
          durationSeconds: parsed.durationSeconds,
          status: parsed.status,
          pairing: parsed.pairing,
          event: parsed.event,
          proposalId: parsed.proposalId,
          shortSummary: await renderShortSummary(parsed, keys, input.locale),
          openQuestions: { count: questions.length, first: questions[0] ?? null },
          automation: parsed.automation,
        },
      };
    }),
  );
}

/**
 * Issue #1695: the stored notes' short summary rendered with `renderMeetingNotes`, from the speaker
 * keys and the mapped speakers the same statement returned, so it costs no further query; `null`
 * without notes.
 */
async function renderShortSummary(
  row: z.infer<typeof rowSchema>,
  speakerKeys: string[],
  locale: string,
): Promise<string | null> {
  const notes = parseStoredMeetingNotes(row.meetingNotes ?? undefined);
  if (!notes) return null;
  const mapped = new Map((row.mappedSpeakers ?? []).map((entry) => [entry.speaker, entry]));
  const speakers: TranscriptSpeaker[] = speakerKeys.map((speaker, index) => {
    const person = mapped.get(speaker);
    return {
      speaker,
      ordinal: index + 1,
      person: person ? { id: person.personId, name: person.name && person.name.length > 0 ? person.name : null } : null,
    };
  });
  return (await renderMeetingNotes(notes, speakers, locale)).shortSummary;
}
