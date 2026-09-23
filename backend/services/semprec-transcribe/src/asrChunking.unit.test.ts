import { describe, expect, it } from "vitest";
import { ASR_CHUNK_OVERLAP_SECONDS, ASR_CHUNK_SECONDS, computeAsrChunkBoundaries } from "./asrChunking.js";

describe("computeAsrChunkBoundaries", () => {
  it("returns no chunks for a non-positive or non-finite duration", () => {
    expect(computeAsrChunkBoundaries(0)).toEqual([]);
    expect(computeAsrChunkBoundaries(-5)).toEqual([]);
    expect(computeAsrChunkBoundaries(Number.NaN)).toEqual([]);
    expect(computeAsrChunkBoundaries(Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it("covers a recording shorter than one chunk with exactly one chunk", () => {
    expect(computeAsrChunkBoundaries(90)).toEqual([{ start: 0, end: 90 }]);
  });

  it("splits a recording just over one chunk into two overlapping chunks", () => {
    const totalDurationSeconds = ASR_CHUNK_SECONDS + 60;

    const boundaries = computeAsrChunkBoundaries(totalDurationSeconds);

    expect(boundaries).toEqual([
      { start: 0, end: ASR_CHUNK_SECONDS },
      { start: ASR_CHUNK_SECONDS - ASR_CHUNK_OVERLAP_SECONDS, end: totalDurationSeconds },
    ]);
  });

  it("produces the expected chunk count and overlap for a multi-hour recording", () => {
    const totalDurationSeconds = 3 * 60 * 60;

    const boundaries = computeAsrChunkBoundaries(totalDurationSeconds);

    expect(boundaries).toHaveLength(10);
    expect(boundaries[0]).toEqual({ start: 0, end: ASR_CHUNK_SECONDS });
    expect(boundaries.at(-1)).toEqual({ start: expect.any(Number), end: totalDurationSeconds });
    for (let i = 1; i < boundaries.length; i += 1) {
      const previous = boundaries[i - 1]!;
      const current = boundaries[i]!;
      expect(previous.end - current.start).toBe(ASR_CHUNK_OVERLAP_SECONDS);
    }
  });

  it("ends the last chunk exactly at the total duration with no trailing sliver chunk", () => {
    const boundaries = computeAsrChunkBoundaries(2 * ASR_CHUNK_SECONDS);

    expect(boundaries.at(-1)?.end).toBe(2 * ASR_CHUNK_SECONDS);
    expect(boundaries.every((b) => b.end <= 2 * ASR_CHUNK_SECONDS)).toBe(true);
  });
});
