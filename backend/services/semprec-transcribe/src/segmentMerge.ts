import type { AsrChunkBoundary } from "./asrChunking.js";
import type { DiarizationTurn, TranscriptionSegment } from "./audioGatewayClient.js";

/** One entry of a transcript's `computed.segments`: times are seconds from the start of the recording. */
export interface TranscriptSegment {
  speaker: string;
  text: string;
  startsAt: number;
  endsAt: number;
}

/** Segment times are relative to the chunk. */
export interface AsrChunkInput {
  boundary: AsrChunkBoundary;
  segments: TranscriptionSegment[];
}

/** A silence longer than this between two runs of the same speaker still starts a new segment. */
export const SEGMENT_PAUSE_BREAK_SECONDS = 1.5;

/** Used when diarization found no turns but ASR produced text; keyed like pyannoteAI's first speaker. */
export const FALLBACK_SPEAKER = "SPEAKER_00";

interface TimedText {
  start: number;
  end: number;
  text: string;
}

/** Millisecond precision, so chunk-offset float noise never makes two runs differ. */
function roundTime(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/**
 * Symmetric mid-band cut over the shared band `[later.start, earlier.end]`: the earlier chunk keeps
 * segment midpoints strictly before the band's midpoint, the later one the rest, so every instant
 * has exactly one owner.
 */
function dedupeChunkOverlaps(chunks: readonly AsrChunkInput[]): TimedText[] {
  const kept: TimedText[] = [];
  chunks.forEach((chunk, index) => {
    const previous = chunks[index - 1];
    const next = chunks[index + 1];
    const lowerCut = previous ? (chunk.boundary.start + previous.boundary.end) / 2 : -Infinity;
    const upperCut = next ? (next.boundary.start + chunk.boundary.end) / 2 : Infinity;
    for (const segment of chunk.segments) {
      const start = roundTime(chunk.boundary.start + segment.start);
      const end = roundTime(chunk.boundary.start + Math.max(segment.end, segment.start));
      const midpoint = (start + end) / 2;
      if (midpoint < lowerCut || midpoint >= upperCut) continue;
      const text = segment.text.trim();
      if (text.length === 0) continue;
      kept.push({ start, end, text });
    }
  });
  return kept.sort((a, b) => a.start - b.start || a.end - b.end);
}

function overlapSeconds(segment: TimedText, turn: DiarizationTurn): number {
  return Math.max(0, Math.min(segment.end, turn.end) - Math.max(segment.start, turn.start));
}

function gapSeconds(segment: TimedText, turn: DiarizationTurn): number {
  if (segment.end < turn.start) return turn.start - segment.end;
  if (turn.end < segment.start) return segment.start - turn.end;
  return 0;
}

/**
 * Largest overlap wins, else the time-nearest turn. Ties go to the earliest turn, so the choice
 * never depends on the provider's turn order.
 */
function assignSpeaker(segment: TimedText, sortedTurns: readonly DiarizationTurn[]): string {
  let best: DiarizationTurn | undefined;
  let bestOverlap = 0;
  for (const turn of sortedTurns) {
    const overlap = overlapSeconds(segment, turn);
    if (overlap > bestOverlap) {
      best = turn;
      bestOverlap = overlap;
    }
  }
  if (best) return best.speaker;

  let bestGap = Infinity;
  for (const turn of sortedTurns) {
    const gap = gapSeconds(segment, turn);
    if (gap < bestGap) {
      best = turn;
      bestGap = gap;
    }
  }
  return best?.speaker ?? FALLBACK_SPEAKER;
}

/**
 * Pure. Joins consecutive same-speaker segments unless a longer pause separates them. Output is
 * ordered with monotonic times; speaker keys are the diarization's own, never renamed.
 */
export function mergeTranscriptSegments(
  turns: readonly DiarizationTurn[],
  chunks: readonly AsrChunkInput[],
): TranscriptSegment[] {
  const sortedTurns = [...turns].sort(
    (a, b) => a.start - b.start || a.end - b.end || (a.speaker < b.speaker ? -1 : a.speaker > b.speaker ? 1 : 0),
  );

  const merged: TranscriptSegment[] = [];
  let previousEnd = 0;
  for (const segment of dedupeChunkOverlaps(chunks)) {
    const speaker = assignSpeaker(segment, sortedTurns);
    const startsAt = Math.max(segment.start, previousEnd);
    const endsAt = Math.max(segment.end, startsAt);
    const last = merged.at(-1);
    if (last && last.speaker === speaker && startsAt - last.endsAt <= SEGMENT_PAUSE_BREAK_SECONDS) {
      last.text = `${last.text} ${segment.text}`;
      last.endsAt = endsAt;
    } else {
      merged.push({ speaker, text: segment.text, startsAt, endsAt });
    }
    previousEnd = endsAt;
  }
  return merged;
}
