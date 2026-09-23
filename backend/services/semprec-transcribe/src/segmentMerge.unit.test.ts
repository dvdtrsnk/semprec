import { describe, expect, it } from "vitest";
import { computeAsrChunkBoundaries } from "./asrChunking.js";
import { FALLBACK_SPEAKER, mergeTranscriptSegments, type TranscriptSegment } from "./segmentMerge.js";

function expectMonotonic(segments: TranscriptSegment[]): void {
  let previousEnd = 0;
  for (const segment of segments) {
    expect(segment.startsAt).toBeGreaterThanOrEqual(previousEnd);
    expect(segment.endsAt).toBeGreaterThanOrEqual(segment.startsAt);
    previousEnd = segment.endsAt;
  }
}

describe("mergeTranscriptSegments", () => {
  it("assigns each segment the turn with the largest overlap and joins consecutive same-speaker segments", () => {
    const segments = mergeTranscriptSegments(
      [
        { speaker: "SPEAKER_00", start: 0, end: 4.2 },
        { speaker: "SPEAKER_01", start: 4.2, end: 9 },
      ],
      [
        {
          boundary: { start: 0, end: 9 },
          segments: [
            { start: 0, end: 2, text: " Hello there." },
            { start: 2.1, end: 4, text: "How are you?" },
            // Spans the turn boundary but lies mostly inside SPEAKER_01's turn.
            { start: 3.9, end: 6, text: "Fine, thanks." },
          ],
        },
      ],
    );

    expect(segments).toEqual([
      { speaker: "SPEAKER_00", text: "Hello there. How are you?", startsAt: 0, endsAt: 4 },
      { speaker: "SPEAKER_01", text: "Fine, thanks.", startsAt: 4, endsAt: 6 },
    ]);
  });

  it("breaks one speaker's run on a pause longer than 1.5 s", () => {
    const segments = mergeTranscriptSegments(
      [{ speaker: "SPEAKER_00", start: 0, end: 20 }],
      [
        {
          boundary: { start: 0, end: 20 },
          segments: [
            { start: 0, end: 2, text: "One." },
            { start: 3.5, end: 5, text: "Two." },
            { start: 6.6, end: 8, text: "Three." },
          ],
        },
      ],
    );

    expect(segments.map((segment) => segment.text)).toEqual(["One. Two.", "Three."]);
  });

  it("gives a segment no turn covers to the time-nearest turn, the earlier one on a tie", () => {
    const segments = mergeTranscriptSegments(
      // Deliberately out of order: the tie must not depend on the provider's turn order.
      [
        { speaker: "SPEAKER_01", start: 12, end: 14 },
        { speaker: "SPEAKER_00", start: 0, end: 8 },
      ],
      [
        {
          boundary: { start: 0, end: 20 },
          segments: [
            { start: 8.5, end: 9, text: "near zero" },
            // 1.5 s from both turns.
            { start: 9.5, end: 10.5, text: "tie" },
            { start: 11, end: 11.5, text: "near one" },
          ],
        },
      ],
    );

    expect(segments.map(({ speaker, text }) => ({ speaker, text }))).toEqual([
      { speaker: "SPEAKER_00", text: "near zero tie" },
      { speaker: "SPEAKER_01", text: "near one" },
    ]);
  });

  it("uses the fallback speaker when diarization returned no turns", () => {
    const segments = mergeTranscriptSegments(
      [],
      [{ boundary: { start: 0, end: 5 }, segments: [{ start: 0, end: 1, text: "Alone." }] }],
    );

    expect(segments).toEqual([{ speaker: FALLBACK_SPEAKER, text: "Alone.", startsAt: 0, endsAt: 1 }]);
  });

  it("resolves overlapping turns deterministically and keeps the original speaker keys", () => {
    const segments = mergeTranscriptSegments(
      [
        { speaker: "SPEAKER_03", start: 0, end: 5 },
        { speaker: "SPEAKER_07", start: 1, end: 3 },
      ],
      [{ boundary: { start: 0, end: 5 }, segments: [{ start: 1, end: 3, text: "Both talking." }] }],
    );

    expect(segments).toEqual([{ speaker: "SPEAKER_03", text: "Both talking.", startsAt: 1, endsAt: 3 }]);
  });

  it("cuts the chunk overlap symmetrically at the band midpoint: no duplicate, no gap", () => {
    // 25 minutes: chunk 0 = [0, 1200], chunk 1 = [1170, 1500]; the shared band is [1170, 1200], cut at 1185.
    const [first, second] = computeAsrChunkBoundaries(25 * 60);
    if (!first || !second) throw new Error("expected two chunks");

    const segments = mergeTranscriptSegments(
      [{ speaker: "SPEAKER_00", start: 0, end: 1500 }],
      [
        {
          boundary: first,
          segments: [
            { start: 1160, end: 1170, text: "before band." },
            { start: 1175, end: 1180, text: "early in band." },
            { start: 1188, end: 1196, text: "late in band (chunk 0 copy)." },
          ],
        },
        {
          boundary: second,
          // Times are relative to the chunk: 5..10 is 1175..1180 in the recording.
          segments: [
            { start: 5, end: 10, text: "early in band (chunk 1 copy)." },
            { start: 18, end: 26, text: "late in band." },
            { start: 40, end: 45, text: "after band." },
          ],
        },
      ],
    );

    expect(segments).toEqual([
      { speaker: "SPEAKER_00", text: "before band.", startsAt: 1160, endsAt: 1170 },
      { speaker: "SPEAKER_00", text: "early in band.", startsAt: 1175, endsAt: 1180 },
      { speaker: "SPEAKER_00", text: "late in band.", startsAt: 1188, endsAt: 1196 },
      { speaker: "SPEAKER_00", text: "after band.", startsAt: 1210, endsAt: 1215 },
    ]);
    expectMonotonic(segments);
  });

  it("gives a segment centred exactly on the cut to the later chunk only", () => {
    const [first, second] = computeAsrChunkBoundaries(25 * 60);
    if (!first || !second) throw new Error("expected two chunks");

    const segments = mergeTranscriptSegments(
      [{ speaker: "SPEAKER_00", start: 0, end: 1500 }],
      [
        { boundary: first, segments: [{ start: 1184, end: 1186, text: "from chunk 0" }] },
        { boundary: second, segments: [{ start: 14, end: 16, text: "from chunk 1" }] },
      ],
    );

    expect(segments.map((segment) => segment.text)).toEqual(["from chunk 1"]);
  });

  it("clamps overlapping ASR segments so times stay monotonic, and drops empty text", () => {
    const segments = mergeTranscriptSegments(
      [
        { speaker: "SPEAKER_00", start: 0, end: 2 },
        { speaker: "SPEAKER_01", start: 2, end: 6 },
      ],
      [
        {
          boundary: { start: 0, end: 6 },
          segments: [
            { start: 0, end: 2.5, text: "First." },
            { start: 2.2, end: 5, text: "Second." },
            { start: 5, end: 5.5, text: "   " },
          ],
        },
      ],
    );

    expect(segments).toEqual([
      { speaker: "SPEAKER_00", text: "First.", startsAt: 0, endsAt: 2.5 },
      { speaker: "SPEAKER_01", text: "Second.", startsAt: 2.5, endsAt: 5 },
    ]);
    expectMonotonic(segments);
  });

  it("returns the same output for the same input", () => {
    const turns = [{ speaker: "SPEAKER_00", start: 0, end: 3 }];
    const chunks = [{ boundary: { start: 0, end: 3 }, segments: [{ start: 0.1, end: 0.2, text: "a" }] }];

    expect(mergeTranscriptSegments(turns, chunks)).toEqual(mergeTranscriptSegments(turns, chunks));
  });

  it("returns no segments when ASR returned none", () => {
    expect(mergeTranscriptSegments([{ speaker: "SPEAKER_00", start: 0, end: 1 }], [])).toEqual([]);
  });
});
