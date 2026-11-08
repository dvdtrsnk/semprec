/** Issue #182's fixed chunking policy for step 3 (ASR): 20-minute chunks with a 30-second overlap. */
export const ASR_CHUNK_SECONDS = 20 * 60;
export const ASR_CHUNK_OVERLAP_SECONDS = 30;

export interface AsrChunkBoundary {
  start: number;
  end: number;
}

/**
 * Splits `[0, totalDurationSeconds)` into fixed-size chunks that each overlap the next by
 * `ASR_CHUNK_OVERLAP_SECONDS`, clipped to the recording's actual duration. A recording shorter
 * than one chunk still produces exactly one chunk covering the whole thing.
 */
export function computeAsrChunkBoundaries(totalDurationSeconds: number): AsrChunkBoundary[] {
  if (!Number.isFinite(totalDurationSeconds) || totalDurationSeconds <= 0) return [];

  const boundaries: AsrChunkBoundary[] = [];
  let start = 0;
  while (start < totalDurationSeconds) {
    const end = Math.min(start + ASR_CHUNK_SECONDS, totalDurationSeconds);
    boundaries.push({ start, end });
    if (end >= totalDurationSeconds) break;
    start = end - ASR_CHUNK_OVERLAP_SECONDS;
  }
  return boundaries;
}
