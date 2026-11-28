/** Step 3 (ASR): 20-minute chunks with a 30-second overlap. */
export const ASR_CHUNK_SECONDS = 20 * 60;
export const ASR_CHUNK_OVERLAP_SECONDS = 30;

export interface AsrChunkBoundary {
  start: number;
  end: number;
}

/** Clipped to the duration; a short recording still yields exactly one chunk. */
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
