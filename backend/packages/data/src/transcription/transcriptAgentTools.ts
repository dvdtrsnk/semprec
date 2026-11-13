// Issue #1832: the two read-only agent tools over a transcript, declared in the systemDatabases module
// manifest. Both read through the composition of the transcript detail endpoint (`readTranscriptDetail`:
// speaker names, the meeting notes rendered with those names, the display name of issue #1830) and write
// nothing, so Semp reads a recording the way a person does and never sees an anonymous `SPEAKER_00`
// where the people are known.
import type { Pool } from "pg";
import { z } from "zod";
import { currentTenantScope } from "@semprec/shared";
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
/** The segments added on each side of a range when the call names no `context`, and the most it may name. */
export const TRANSCRIPT_SEGMENT_CONTEXT_DEFAULT = 3;
export const TRANSCRIPT_SEGMENT_CONTEXT_MAX = 3;

export const transcriptGetArgsSchema = z.object({ transcriptId: z.uuid() }).strict();

/**
 * A range is either `fromIndex` and `toIndex` (segment indexes, both inclusive) or `startsAt` and `endsAt`
 * (seconds of the recording); `readTranscriptSegmentRange` refuses a call that names neither pair complete, or both.
 */
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
   * True on an answer that carries the content of a transcript linked to a sensitive database (issue #1999): the
   * session composition copies it to the tool result's details so the stored result is redacted, as for the
   * generic-operation tools (issue #1827).
   */
  sensitive?: true;
}

export type TranscriptAgentTool = (currentRunId: string, args: unknown) => Promise<TranscriptAgentToolResult>;

/** The one answer for an unknown transcript, another tenant's and one in the Trash. */
const TRANSCRIPT_NOT_FOUND: TranscriptAgentToolResult = {
  error: true,
  result: JSON.stringify({ error: "not_found", message: "Transcript not found" }),
};

/**
 * The answer when the agent's project may not read the transcript because it is linked to a sensitive database
 * (issue #1999). The message names neither the database nor the record the transcript is linked to.
 */
const TRANSCRIPT_FORBIDDEN: TranscriptAgentToolResult = {
  error: true,
  result: JSON.stringify({ error: "forbidden", message: "The agent's project may not read this transcript" }),
};

/** The answer when the call has no run of the tenant in scope to read for. */
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

/** What `readForRun` answers for a transcript the run may read. */
interface TranscriptRead {
  detail: z.infer<typeof detailSchema>;
  /** True when the transcript is linked to a sensitive database, whatever access the project holds there. */
  sensitive: boolean;
}

/**
 * Reads the transcript for the run in scope, inside one transaction: `null` when there is no run of the tenant
 * in scope, `"notFound"` when the id names no live transcript of that tenant (the same for an unknown id,
 * another tenant's and one in the Trash, since row-level security shows only the caller's rows), `"forbidden"`
 * when the transcript is linked to a sensitive database on which the run's project has no read access
 * (issue #1999), otherwise the detail composition checked at the edge. The inherited check is the one `item.get` of
 * the transcript makes, in the same transaction as the read, and the per-turn read allowance of a transcript the
 * user attached opens it as it opens `item.get`. A run with no project holds no grant, so it is refused a
 * transcript that is linked to a sensitive database. The tenant is the one the caller's scope names; no argument
 * chooses it.
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
 * `transcript.get { transcriptId }` (issue #1832): the transcript's header, its speakers with the names they
 * are mapped to, the summary, decisions and action items of its meeting notes with speaker names in place of
 * speaker keys (the owner's full name, a first name in running text), its Event, and how many segments and
 * speakers it has. A transcript whose notes are not stored yet has `summary: null`, no decisions and no action
 * items. Reads only the tenant of the calling run and writes nothing.
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

/** The indexes `[from, to]` (inclusive) of the segments a call asks for, or why it cannot be answered. */
export type TranscriptSegmentRangeRead = { from: number; to: number } | { empty: true } | TranscriptAgentToolResult;

/** The part of a `transcript.segment.get` call that names the range. */
export type TranscriptSegmentRangeArgs = Pick<
  TranscriptSegmentGetArgs,
  "fromIndex" | "toIndex" | "startsAt" | "endsAt"
>;

export function isTranscriptSegmentRangeFailure(value: TranscriptSegmentRangeRead): value is TranscriptAgentToolResult {
  return "error" in value;
}

/**
 * Resolves the range a call names against `segments`. Exactly one of the two pairs must be complete: both of
 * `fromIndex` and `toIndex`, or both of `startsAt` and `endsAt` (a start after the end, or a time range of no
 * length, is refused). The range is too large (`rangeTooLarge`) when it asks for more than
 * `TRANSCRIPT_SEGMENT_RANGE_MAX_SEGMENTS` segments or spans more than `TRANSCRIPT_SEGMENT_RANGE_MAX_SECONDS`
 * seconds: for an index range the requested count and the time from the first to the last existing segment of
 * it, for a time range the requested length and the segments that overlap it. A time range selects the
 * segments that start before its end and end after its start. A range that selects no segment is `{ empty }`.
 * Shared by `transcript.segment.get` and the `transcriptSegment` message ref (issue #1834).
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

/** A segment of a transcript as the detail composition renders it: `label` is the speaker's name. */
export interface TranscriptRenderedSegment {
  index: number;
  speaker: string;
  label: string;
  text: string;
  startsAt: number;
  endsAt: number;
}

/**
 * The segments of a resolved range with `context` more on each side, ordered by index, the added ones flagged
 * `isContext`. `from` and `to` are the first and last index of the range itself, `null` when it selects no segment.
 */
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
 * `transcript.segment.get { transcriptId, fromIndex | startsAt, toIndex | endsAt, context? }` (issue #1832):
 * the segments of one stretch of a recording, with the speaker's name as `label`, and `context` (default 3,
 * at most 3) more segments on each side with `isContext` true, ordered by index. `from` and `to` are the
 * first and last index of the stretch itself, without the context, and `null` when it holds no segment (a
 * transcript without segments, a range past the end, or a time range in a silence). See
 * `readTranscriptSegmentRange` for the two ways to name a range and the size limit. Reads only the tenant of the
 * calling run and writes nothing.
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
