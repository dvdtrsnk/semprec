// Issue #1834: what is specific to the `transcriptSegment` kind of a Semp message ref (the generic ref schema,
// the stored `context` and the label and state machinery are issue #1682's). A ref names a stretch of one
// recording by seconds on its timeline; this module validates it, expands it into the block the model reads
// when a turn is prepared, and labels it for the message history. The segment reading is the one of
// `transcript.segment.get` (`readTranscriptSegmentRange`, `windowTranscriptSegments`), so a stretch is bounded and
// windowed the same way for the tool and the ref. Validation and labelling read a whole message's refs with one
// statement per kind (docs/adr/2026-11-13-transcript-segment-refs-resolve-in-batches-and-are-labelled-by-display-name.md).
// Nothing here writes or logs; the expanded text is returned to the caller and kept nowhere.
import type { PoolClient } from "pg";
import { z } from "zod";
import type { SempMessageRef } from "@semprec/shared";
import { getTenantUserLocale } from "../auth/usersStore.js";
import { EVENTS_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { getSystemTimezone } from "../systemSettings.js";
import { resolveTranscriptDisplayName } from "./transcriptDisplayName.js";
import { readTranscriptDetail } from "./transcriptDetail.js";
import {
  isTranscriptSegmentRangeFailure,
  readTranscriptSegmentRange,
  TRANSCRIPT_SEGMENT_CONTEXT_MAX,
  windowTranscriptSegments,
  type TranscriptRenderedSegment,
} from "./transcriptAgentTools.js";

export type TranscriptSegmentRef = Extract<SempMessageRef, { kind: "transcriptSegment" }>;

const storedSegmentsSchema = z.array(
  z.object({ speaker: z.string(), text: z.string(), startsAt: z.number(), endsAt: z.number() }),
);

/** What the model is given for one ref, with the label and trash state the turn builder renders around it. */
export interface TranscriptSegmentRefExpansion {
  label: string;
  state: "active" | "trashed";
  details: {
    transcriptId: string;
    startsAt: number;
    endsAt: number;
    /** First and last index of the segments inside the range itself; `null` when the range holds none. */
    from: number | null;
    to: number | null;
    /** The speakers' names; empty for a transcript in the trash, whose speaker mapping is not read. */
    speakers: Array<{ speaker: string; label: string }>;
    /** The range with three segments of context on each side, flagged `isContext`. */
    segments: Array<TranscriptRenderedSegment & { isContext: boolean }>;
  };
}

type StoredSegment = z.infer<typeof storedSegmentsSchema>[number];

interface TranscriptRow {
  deletedAt: Date | null;
  segments: unknown;
}

/**
 * The item `itemId` when it belongs to the tenant's Transcripts database, live or in the Trash; `null` for an
 * unknown id, another tenant's (row-level security shows only the caller's rows) and an item of another database.
 */
async function readTranscriptRow(client: PoolClient, itemId: string): Promise<TranscriptRow | null> {
  const { rows } = await client.query<{ deleted_at: Date | null; segments: unknown }>(
    `SELECT i.deleted_at, i.computed -> 'segments' AS segments
       FROM items i JOIN databases d ON d.id = i.database_id AND d.tenant_id = i.tenant_id
      WHERE i.id = $1 AND d.owner_module_id = $2`,
    [itemId, TRANSCRIPTS_MODULE_ID],
  );
  const row = rows[0];
  return row ? { deletedAt: row.deleted_at, segments: row.segments ?? [] } : null;
}

/** Whether the numbers of `ref` can name a stretch at all; no read is needed to refuse the rest. */
function hasUsableRange(ref: TranscriptSegmentRef): boolean {
  return Number.isFinite(ref.startsAt) && Number.isFinite(ref.endsAt) && ref.startsAt >= 0;
}

/**
 * The stored segments of each transcript the refs name, in one statement however many refs there are: a
 * transcript of the tenant's Transcripts database, live or in the Trash, is a key of the result; an unknown id,
 * another tenant's (row-level security shows only the caller's rows) and an item of another database are not.
 * Refs that cannot name a stretch (`hasUsableRange`) are not read for.
 */
async function readStoredSegments(
  client: PoolClient,
  refs: readonly TranscriptSegmentRef[],
): Promise<Map<string, StoredSegment[]>> {
  const ids = [...new Set(refs.filter(hasUsableRange).map((ref) => ref.itemId))];
  const result = new Map<string, StoredSegment[]>();
  if (ids.length === 0) return result;
  const { rows } = await client.query<{ item_id: string; segments: unknown }>(
    `SELECT i.id::text AS item_id, i.computed -> 'segments' AS segments
       FROM unnest($1::uuid[]) AS r(item_id)
       JOIN items i ON i.id = r.item_id
       JOIN databases d ON d.id = i.database_id AND d.tenant_id = i.tenant_id
      WHERE d.owner_module_id = $2`,
    [ids, TRANSCRIPTS_MODULE_ID],
  );
  for (const row of rows) result.set(row.item_id, storedSegmentsSchema.parse(row.segments ?? []));
  return result;
}

/**
 * Whether `ref` names a stretch of a transcript that `transcript.segment.get` would read, given the stored
 * `segments` of the item it names (`undefined` when the item is no transcript of the caller's tenant): the item
 * is in the Transcripts database (a transcript in the Trash still counts, and is shown as recoverable in the
 * history), `0 <= startsAt < endsAt` (a range of no length selects nothing and is refused, as it is by the tool),
 * and the range does not exceed 200 segments or 15 minutes. A range that reaches past the end of the recording is
 * valid and is clamped when expanded. This is the decision for one ref; `validateTranscriptSegmentRefs` reads
 * the segments of a whole message.
 */
export function validateTranscriptSegmentRef(
  ref: TranscriptSegmentRef,
  segments: readonly StoredSegment[] | undefined,
): boolean {
  if (!hasUsableRange(ref) || segments === undefined) return false;
  const range = readTranscriptSegmentRange({ startsAt: ref.startsAt, endsAt: ref.endsAt }, [...segments]);
  return !isTranscriptSegmentRangeFailure(range);
}

/**
 * `validateTranscriptSegmentRef` for each of `refs`, in order, over one statement for the whole list that
 * returns the segments of each distinct transcript once (no statement when no ref has a usable range). Runs in
 * the caller's transaction and tenant scope.
 */
export async function validateTranscriptSegmentRefs(
  client: PoolClient,
  refs: readonly TranscriptSegmentRef[],
): Promise<boolean[]> {
  const stored = await readStoredSegments(client, refs);
  return refs.map((ref) => validateTranscriptSegmentRef(ref, stored.get(ref.itemId)));
}

/** `m:ss`, or `h:mm:ss` from one hour on, of a second count on the recording's timeline (fractions are cut off). */
function formatClock(seconds: number): string {
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

/** "Client meeting 5:12-6:30": the transcript's display name, when it has one, and the stretch. */
function composeLabel(displayName: string | null, ref: TranscriptSegmentRef): string {
  const range = `${formatClock(ref.startsAt)}-${formatClock(ref.endsAt)}`;
  return displayName === null ? range : `${displayName} ${range}`;
}

interface TranscriptView {
  state: "active" | "trashed";
  displayName: string | null;
  speakers: Array<{ speaker: string; label: string }>;
  segments: TranscriptRenderedSegment[];
}

const textOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * The display name (issue #1830: the user's `name`, else the name of the live Event the transcript is linked
 * to, else "Recording D. M. HH:MM" from `date`) of each transcript the ids name, for a live transcript and one in
 * the Trash alike, so a ref's label does not change when its transcript is trashed and restored. Costs one
 * statement for the names, dates and Events of every id, plus one each for the tenant's language and time zone,
 * however many ids there are. An id that is no transcript of the caller's tenant is not a key of the result; a
 * transcript without a name, a live Event or a readable date maps to `null`. Reads nothing of the segments,
 * speakers or notes. Runs in the caller's transaction and tenant scope.
 */
async function readTranscriptDisplayNames(
  client: PoolClient,
  itemIds: readonly string[],
): Promise<Map<string, string | null>> {
  const ids = [...new Set(itemIds)];
  const names = new Map<string, string | null>();
  if (ids.length === 0) return names;
  // The Event is the first edge of the transcript's `event` relation that leads to an Event item, as in
  // `readTranscriptDetail`; a trashed Event counts as no Event.
  const { rows } = await client.query<{ item_id: string; name: unknown; date: unknown; event_name: unknown }>(
    `SELECT i.id::text AS item_id, i.properties -> 'name' AS name, i.properties -> 'date' AS date, ev.name AS event_name
       FROM unnest($1::uuid[]) AS r(item_id)
       JOIN items i ON i.id = r.item_id
       JOIN databases d ON d.id = i.database_id AND d.tenant_id = i.tenant_id AND d.owner_module_id = $2
       LEFT JOIN LATERAL (
         SELECT CASE WHEN e.deleted_at IS NULL THEN e.properties -> 'name' END AS name
           FROM properties p
           JOIN relation_definitions rd ON p.id IN (rd.property_id_a, rd.property_id_b)
           JOIN item_relations ir ON ir.relation_definition_id = rd.id AND i.id IN (ir.item_a, ir.item_b)
           JOIN items e ON e.id = CASE WHEN ir.item_a = i.id THEN ir.item_b ELSE ir.item_a END
           JOIN databases ed ON ed.id = e.database_id AND ed.tenant_id = e.tenant_id AND ed.owner_module_id = $3
          WHERE p.database_id = d.id AND p.tenant_id = d.tenant_id AND p.key = 'event'
          ORDER BY ir.id LIMIT 1) ev ON true`,
    [ids, TRANSCRIPTS_MODULE_ID, EVENTS_MODULE_ID],
  );
  if (rows.length === 0) return names;
  const locale = (await getTenantUserLocale(client)) ?? "cs";
  const zone = await getSystemTimezone(client);
  for (const row of rows) {
    names.set(
      row.item_id,
      await resolveTranscriptDisplayName(
        { name: textOrNull(row.name), eventName: textOrNull(row.event_name), date: textOrNull(row.date) },
        zone,
        locale,
      ),
    );
  }
  return names;
}

/**
 * A live transcript is read through the detail composition (names of the speakers, the display name of issue
 * #1830 with its Event), the one `transcript.get` and `transcript.segment.get` read. A transcript in the Trash
 * is not readable through it and its speaker mapping is not read: its display name comes from
 * `readTranscriptDisplayNames`, the one that labels the ref in the history, and its segments carry the speaker
 * keys as labels.
 */
async function readTranscriptView(client: PoolClient, itemId: string): Promise<TranscriptView | null> {
  const row = await readTranscriptRow(client, itemId);
  if (!row) return null;
  if (!row.deletedAt) {
    const detail = await readTranscriptDetail(client, itemId, (await getTenantUserLocale(client)) ?? "cs");
    return {
      state: "active",
      displayName: detail.displayName,
      speakers: detail.speakers.map(({ speaker, label }) => ({ speaker, label })),
      segments: detail.segments,
    };
  }
  return {
    state: "trashed",
    displayName: (await readTranscriptDisplayNames(client, [itemId])).get(itemId) ?? null,
    speakers: [],
    segments: storedSegmentsSchema
      .parse(row.segments)
      .map((segment, index) => ({ ...segment, index, label: segment.speaker })),
  };
}

/**
 * The block the turn builder puts into the model's context for `ref`: the segments of the stretch with the
 * speakers' names plus three segments of context on each side, from the segment reading of
 * `transcript.segment.get`, and the label of the ref. A range past the end of the recording is clamped to what
 * exists. `null` when the item is no transcript of the tenant, or when the stretch no longer passes the limits
 * of the tool (the recording changed since the ref was validated). The result is for one turn: the stored
 * message keeps only the ref and its label, and nothing here logs the text.
 */
export async function expandTranscriptSegmentRef(
  client: PoolClient,
  ref: TranscriptSegmentRef,
): Promise<TranscriptSegmentRefExpansion | null> {
  const view = await readTranscriptView(client, ref.itemId);
  if (!view) return null;
  const range = readTranscriptSegmentRange({ startsAt: ref.startsAt, endsAt: ref.endsAt }, view.segments);
  if (isTranscriptSegmentRangeFailure(range)) return null;
  const { from, to, segments } = windowTranscriptSegments(view.segments, range, TRANSCRIPT_SEGMENT_CONTEXT_MAX);
  return {
    label: composeLabel(view.displayName, ref),
    state: view.state,
    details: {
      transcriptId: ref.itemId,
      startsAt: ref.startsAt,
      endsAt: ref.endsAt,
      from,
      to,
      speakers: view.speakers,
      segments,
    },
  };
}

/**
 * The label of each of `refs` for the message history, in order, from the transcript's current display name, so
 * a renamed transcript shows its new name: "Client meeting 5:12-6:30", or just the stretch when the transcript has
 * no name, no live Event and no date. A transcript in the Trash is labelled the same way as a live one. `null`
 * for an item that is no transcript of the tenant. One batch of statements for the whole list, however many refs
 * and transcripts it holds (`readTranscriptDisplayNames`), and none for an empty list. The trash or purge state
 * of a ref is the generic machinery's (`resolveSempHistoryContexts`).
 */
export async function labelTranscriptSegmentRefs(
  client: PoolClient,
  refs: readonly TranscriptSegmentRef[],
): Promise<Array<string | null>> {
  const names = await readTranscriptDisplayNames(
    client,
    refs.map((ref) => ref.itemId),
  );
  return refs.map((ref) => (names.has(ref.itemId) ? composeLabel(names.get(ref.itemId) ?? null, ref) : null));
}
