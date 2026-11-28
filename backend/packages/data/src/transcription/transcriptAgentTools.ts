// The two read-only agent tools over a transcript. Both read through `readTranscriptDetail`, so the
// agent sees speaker names, not an anonymous `SPEAKER_00`, where the people are known.
import type { Pool } from "pg";
import { z } from "zod";
import { currentTenantScope } from "@alldots/shared";
import { assertAgentDatabaseAccess } from "../agentGrants/agentDatabaseAccess.js";
import { sensitiveSourceDatabaseIds } from "../agentGrants/inheritedSensitivity.js";
import { getAgentRun } from "../agentRuns/agentRunsStore.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemById } from "../chokePoint/itemsStore.js";
import { withTransaction } from "../db/pool.js";
import { getTenantUserLocale } from "../auth/usersStore.js";
import { ForbiddenError } from "../errors.js";
import { TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { readTranscriptDetail } from "./transcriptDetail.js";

/** A range of `transcript.segment.get` spans at most this many segments... */
export const TRANSCRIPT_SEGMENT_RANGE_MAX_SEGMENTS = 200;
/** ...and at most this many seconds of recording, whichever is reached first. */
export const TRANSCRIPT_SEGMENT_RANGE_MAX_SECONDS = 15 * 60;
/** Segments added on each side of a range by default; also the maximum. */
export const TRANSCRIPT_SEGMENT_CONTEXT_DEFAULT = 3;
export const TRANSCRIPT_SEGMENT_CONTEXT_MAX = 3;

export const transcriptGetArgsSchema = z.object({ transcriptId: z.uuid() }).strict();

/** Either `fromIndex`..`toIndex` (inclusive) or `startsAt`..`endsAt` (seconds); exactly one complete pair. */
export const transcriptSegmentGetArgsSchema = z
  .object({
    transcriptId: z.uuid(),
    fromIndex: z.number().int().nonnegative().optional(),
    toIndex: z.number().int().nonnegative().optional(),
    startsAt: z.number().nonnegative().optional(),
    endsAt: z.number().nonnegative().optional(),
    context: z.number().int().min(0).max(TRANSCRIPT_SEGMENT_CONTEXT_MAX).optional(),
  })
  .strict();
type TranscriptSegmentGetArgs = z.infer<typeof transcriptSegmentGetArgsSchema>;

export interface TranscriptAgentToolResult {
  error: boolean;
  result: string;
  /**
   * Set when the content is of a transcript linked to a sensitive database; the session copies it to
   * the tool result's details so the stored result is redacted.
   */
  sensitive?: true;
}

export type TranscriptAgentTool = (currentRunId: string, args: unknown) => Promise<TranscriptAgentToolResult>;

const TRANSCRIPT_NOT_FOUND: TranscriptAgentToolResult = {
  error: true,
  result: JSON.stringify({ error: "not_found", message: "Transcript not found" }),
};

/** The message names neither the sensitive database nor the record the transcript is linked to. */
const TRANSCRIPT_FORBIDDEN: TranscriptAgentToolResult = {
  error: true,
  result: JSON.stringify({ error: "forbidden", message: "The agent's project may not read this transcript" }),
};

const RUN_NOT_FOUND: TranscriptAgentToolResult = {
  error: true,
  result: JSON.stringify({ error: "run_not_found", message: "No run context for this call" }),
};

function validationFailed(reason: string, message: string, fields?: string[]): TranscriptAgentToolResult {
  return {
    error: true,
    result: JSON.stringify({ error: "validation_failed", reason, message, ...(fields ? { fields } : {}) }),
  };
}

const detailSchema = z.object({
  displayName: z.string().nullable(),
  date: z.string().nullable(),
  durationSeconds: z.number().nullable(),
  language: z.string().nullable(),
  speakerCount: z.number().int(),
  speakers: z.array(z.object({ speaker: z.string(), label: z.string() })),
  segments: z.array(
    z.object({
      index: z.number().int(),
      speaker: z.string(),
      label: z.string(),
      text: z.string(),
      startsAt: z.number(),
      endsAt: z.number(),
    }),
  ),
  meetingNotes: z
    .object({
      summary: z.string(),
      decisions: z.array(z.string()),
      actionItems: z.array(
        z.object({
          id: z.number().int(),
          text: z.string(),
          ownerLabel: z.string().nullable(),
          due: z.string().nullable(),
        }),
      ),
    })
    .nullable(),
  event: z.object({ id: z.string(), name: z.string().nullable(), date: z.string().nullable() }).nullable(),
});

interface TranscriptRead {
  detail: z.infer<typeof detailSchema>;
  /** Linked to a sensitive database, whatever access the project holds there. */
  sensitive: boolean;
}

/**
 * One transaction. `null` without a run of the tenant in scope; `"notFound"` is the same for unknown,
 * other-tenant and trashed ids (RLS shows only the caller's rows); `"forbidden"` when the transcript
 * is linked to a sensitive database the run's project cannot read. The check is the one `item.get`
 * makes, including the per-turn allowance for a user-attached transcript; a run with no project holds
 * no grant. No argument chooses the tenant.
 */
async function readForRun(pool: Pool, runId: string, transcriptId: string) {
  if (!z.uuid().safeParse(runId).success || currentTenantScope()?.kind !== "tenant") return null;
  return withTransaction(pool, async (client): Promise<TranscriptRead | "notFound" | "forbidden" | null> => {
    const run = await getAgentRun(client, runId);
    if (!run) return null;
    const transcripts = await getDatabaseByModuleId(client, TRANSCRIPTS_MODULE_ID);
    const transcript = transcripts && (await getItemById(client, transcripts.id, transcriptId));
    if (!transcripts || !transcript || transcript.deletedAt) return "notFound";
    const linked = (await sensitiveSourceDatabaseIds(client, transcriptId)).length > 0;
    if (run.projectItemId === null) {
      if (linked) return "forbidden";
    } else {
      try {
        await assertAgentDatabaseAccess(client, {
          agentProjectItemId: run.projectItemId,
          databaseId: transcripts.id,
          access: "read",
          readAllowance: { agentRunId: run.id, itemId: transcriptId },
          itemId: transcriptId,
        });
      } catch (err) {
        if (err instanceof ForbiddenError) return "forbidden";
        throw err;
      }
    }
    const locale = (await getTenantUserLocale(client)) ?? "cs";
    return { detail: detailSchema.parse(await readTranscriptDetail(client, transcriptId, locale)), sensitive: linked };
  });
}

/**
 * `transcript.get`: header, speakers with mapped names, meeting notes with names in place of speaker
 * keys, its Event and segment/speaker counts. Notes not stored yet give `summary: null`. Read-only.
 */
export function createTranscriptGetTool(pool: Pool): TranscriptAgentTool {
  return async function transcriptGet(currentRunId, rawArgs) {
    const args = transcriptGetArgsSchema.safeParse(rawArgs);
    if (!args.success) {
      return validationFailed(
        "invalidArguments",
        "Invalid arguments",
        args.error.issues.map((issue) => issue.path.join(".")),
      );
    }
    const read = await readForRun(pool, currentRunId, args.data.transcriptId);
    if (read === null) return RUN_NOT_FOUND;
    if (read === "notFound") return TRANSCRIPT_NOT_FOUND;
    if (read === "forbidden") return TRANSCRIPT_FORBIDDEN;
    const { detail } = read;
    return {
      error: false,
      ...(read.sensitive ? { sensitive: true as const } : {}),
      result: JSON.stringify({
        transcriptId: args.data.transcriptId,
        displayName: detail.displayName,
        date: detail.date,
        durationSeconds: detail.durationSeconds,
        language: detail.language,
        speakers: detail.speakers.map(({ speaker, label }) => ({ speaker, label })),
        summary: detail.meetingNotes?.summary ?? null,
        decisions: detail.meetingNotes?.decisions ?? [],
        actionItems: (detail.meetingNotes?.actionItems ?? []).map(({ id, text, ownerLabel, due }) => ({
          id,
          text,
          ownerLabel,
          due,
        })),
        event: detail.event,
        segmentCount: detail.segments.length,
        speakerCount: detail.speakerCount,
      }),
    };
  };
}

export type TranscriptSegmentRangeRead = { from: number; to: number } | { empty: true } | TranscriptAgentToolResult;

export type TranscriptSegmentRangeArgs = Pick<
  TranscriptSegmentGetArgs,
  "fromIndex" | "toIndex" | "startsAt" | "endsAt"
>;

export function isTranscriptSegmentRangeFailure(value: TranscriptSegmentRangeRead): value is TranscriptAgentToolResult {
  return "error" in value;
}

/**
 * Exactly one pair must be complete; a start after the end or an empty time range is refused. A range
 * is `rangeTooLarge` above the segment or seconds limit (for an index range: requested count and the
 * span of its existing segments; for a time range: its length and overlapping segments). A time range
 * selects segments that start before its end and end after its start. Also used by the
 * `transcriptSegment` message ref.
 */
export function readTranscriptSegmentRange(
  args: TranscriptSegmentRangeArgs,
  segments: Array<{ startsAt: number; endsAt: number }>,
): TranscriptSegmentRangeRead {
  const { fromIndex, toIndex, startsAt, endsAt } = args;
  const byIndex = fromIndex !== undefined || toIndex !== undefined;
  const byTime = startsAt !== undefined || endsAt !== undefined;
  if (
    byIndex === byTime ||
    (byIndex && (fromIndex === undefined || toIndex === undefined)) ||
    (byTime && (startsAt === undefined || endsAt === undefined))
  ) {
    return validationFailed("rangeRequired", "Give either fromIndex and toIndex, or startsAt and endsAt, and not both");
  }
  const tooLarge = validationFailed(
    "rangeTooLarge",
    `A range spans at most ${TRANSCRIPT_SEGMENT_RANGE_MAX_SEGMENTS} segments or ${TRANSCRIPT_SEGMENT_RANGE_MAX_SECONDS / 60} minutes`,
  );
  if (fromIndex !== undefined && toIndex !== undefined) {
    if (fromIndex > toIndex) return validationFailed("rangeInverted", "fromIndex must not be after toIndex");
    if (toIndex - fromIndex + 1 > TRANSCRIPT_SEGMENT_RANGE_MAX_SEGMENTS) return tooLarge;
    const last = Math.min(toIndex, segments.length - 1);
    const first = segments[fromIndex];
    const end = segments[last];
    if (!first || !end) return { empty: true };
    return end.endsAt - first.startsAt > TRANSCRIPT_SEGMENT_RANGE_MAX_SECONDS
      ? tooLarge
      : { from: fromIndex, to: last };
  }
  if (startsAt === undefined || endsAt === undefined || startsAt >= endsAt)
    return validationFailed("rangeInverted", "startsAt must be before endsAt");
  if (endsAt - startsAt > TRANSCRIPT_SEGMENT_RANGE_MAX_SECONDS) return tooLarge;
  const matching = segments.flatMap((segment, index) =>
    segment.startsAt < endsAt && segment.endsAt > startsAt ? [index] : [],
  );
  const from = matching[0];
  const to = matching.at(-1);
  if (from === undefined || to === undefined) return { empty: true };
  return matching.length > TRANSCRIPT_SEGMENT_RANGE_MAX_SEGMENTS ? tooLarge : { from, to };
}

export interface TranscriptRenderedSegment {
  index: number;
  speaker: string;
  label: string;
  text: string;
  startsAt: number;
  endsAt: number;
}

/** `from`/`to` bound the range itself (`null` when empty); context segments are flagged `isContext`. */
export function windowTranscriptSegments(
  segments: readonly TranscriptRenderedSegment[],
  range: { from: number; to: number } | { empty: true },
  context: number,
): { from: number | null; to: number | null; segments: Array<TranscriptRenderedSegment & { isContext: boolean }> } {
  if ("empty" in range) return { from: null, to: null, segments: [] };
  const { from, to } = range;
  return {
    from,
    to,
    segments: segments
      .filter((segment) => segment.index >= from - context && segment.index <= to + context)
      .map(({ index, speaker, label, text, startsAt, endsAt }) => ({
        index,
        speaker,
        label,
        text,
        startsAt,
        endsAt,
        isContext: index < from || index > to,
      })),
  };
}

/**
 * `transcript.segment.get`: one stretch of a recording with `context` segments on each side, ordered
 * by index. See `readTranscriptSegmentRange` for naming a range and the size limit. Read-only.
 */
export function createTranscriptSegmentGetTool(pool: Pool): TranscriptAgentTool {
  return async function transcriptSegmentGet(currentRunId, rawArgs) {
    const args = transcriptSegmentGetArgsSchema.safeParse(rawArgs);
    if (!args.success) {
      return validationFailed(
        "invalidArguments",
        "Invalid arguments",
        args.error.issues.map((issue) => issue.path.join(".")),
      );
    }
    const read = await readForRun(pool, currentRunId, args.data.transcriptId);
    if (read === null) return RUN_NOT_FOUND;
    if (read === "notFound") return TRANSCRIPT_NOT_FOUND;
    if (read === "forbidden") return TRANSCRIPT_FORBIDDEN;
    const { detail } = read;
    const range = readTranscriptSegmentRange(args.data, detail.segments);
    if (isTranscriptSegmentRangeFailure(range)) return range;
    const { from, to, segments } = windowTranscriptSegments(
      detail.segments,
      range,
      args.data.context ?? TRANSCRIPT_SEGMENT_CONTEXT_DEFAULT,
    );
    return {
      error: false,
      ...(read.sensitive ? { sensitive: true as const } : {}),
      result: JSON.stringify({ transcriptId: args.data.transcriptId, from, to, segments }),
    };
  };
}
