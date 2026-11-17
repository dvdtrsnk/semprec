// The `transcriptSegment` kind of a Semp message ref: a stretch of one recording by seconds. This
// module validates it, expands it into the block the model reads, and labels it for the history,
// reusing the `transcript.segment.get` reading so tool and ref are bounded the same way. Validation and
// labelling read a whole message's refs with one statement per kind. Nothing here writes or logs; the
// expanded text is returned to the caller and kept nowhere.
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

export interface TranscriptSegmentRefExpansion {
  label: string;
  state: "active" | "trashed";
  details: {
    transcriptId: string;
    startsAt: number;
    endsAt: number;
    /** `null` when the range holds no segment. */
    from: number | null;
    to: number | null;
    /** Empty for a trashed transcript, whose speaker mapping is not read. */
    speakers: Array<{ speaker: string; label: string }>;
    segments: Array<TranscriptRenderedSegment & { isContext: boolean }>;
  };
}

type StoredSegment = z.infer<typeof storedSegmentsSchema>[number];

interface TranscriptRow {
  deletedAt: Date | null;
  segments: unknown;
}

/** Live or trashed; `null` for unknown, other-tenant (RLS) and other-database ids. */
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

function hasUsableRange(ref: TranscriptSegmentRef): boolean {
  return Number.isFinite(ref.startsAt) && Number.isFinite(ref.endsAt) && ref.startsAt >= 0;
}

/**
 * One statement for all refs. Live and trashed transcripts are keys of the result; unknown,
 * other-tenant (RLS) and other-database ids are not. Refs without a usable range are not read for.
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
 * `segments` is `undefined` when the item is no transcript of the caller's tenant. A trashed transcript
 * still counts (shown as recoverable). `0 <= startsAt < endsAt` and the tool's size limits apply; a
 * range past the end of the recording is valid and clamped when expanded.
 */
export function validateTranscriptSegmentRef(
  ref: TranscriptSegmentRef,
  segments: readonly StoredSegment[] | undefined,
): boolean {
  if (!hasUsableRange(ref) || segments === undefined) return false;
  const range = readTranscriptSegmentRange({ startsAt: ref.startsAt, endsAt: ref.endsAt }, [...segments]);
  return !isTranscriptSegmentRangeFailure(range);
}

/** One statement for the list (none without a usable range); caller's transaction and tenant scope. */
export async function validateTranscriptSegmentRefs(
  client: PoolClient,
  refs: readonly TranscriptSegmentRef[],
): Promise<boolean[]> {
  const stored = await readStoredSegments(client, refs);
  return refs.map((ref) => validateTranscriptSegmentRef(ref, stored.get(ref.itemId)));
}

/** `m:ss`, or `h:mm:ss` from one hour on; fractions are cut off. */
function formatClock(seconds: number): string {
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

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
 * Live and trashed alike, so a ref's label does not change when its transcript is trashed and
 * restored. One statement for every id plus one each for language and time zone. Non-transcript ids
 * are not keys; a transcript with no name, live Event or readable date maps to `null`.
 */
async function readTranscriptDisplayNames(
  client: PoolClient,
  itemIds: readonly string[],
): Promise<Map<string, string | null>> {
  const ids = [...new Set(itemIds)];
  const names = new Map<string, string | null>();
  if (ids.length === 0) return names;
  // A trashed Event counts as no Event.
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
 * A live transcript is read through the detail composition. A trashed one is not readable through
 * it: its display name comes from `readTranscriptDisplayNames` and its segments are labelled by
 * speaker key.
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
 * The segments of the stretch with speaker names and three context segments each side, clamped to the
 * recording. `null` for a non-transcript or when the stretch no longer passes the tool's limits (the
 * recording changed since validation). The stored message keeps only the ref and its label.
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
 * From the current display name, so a renamed transcript shows its new name; just the stretch when it
 * has none. `null` for a non-transcript. One batch of statements for the whole list. Trash/purge state
 * is the generic machinery's (`resolveSempHistoryContexts`).
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
