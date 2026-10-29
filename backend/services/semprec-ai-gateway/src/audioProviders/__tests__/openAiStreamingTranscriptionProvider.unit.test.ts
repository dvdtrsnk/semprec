import { describe, expect, it } from "vitest";
import { Pcm16To24kResampler } from "../openAiStreamingTranscriptionProvider.js";

function pcm(samples: number[]): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, index * 2));
  return buffer;
}

function samplesOf(buffer: Buffer): number[] {
  return Array.from({ length: buffer.length / 2 }, (_, index) => buffer.readInt16LE(index * 2));
}

describe("Pcm16To24kResampler", () => {
  it("produces three output samples for every two input samples, interpolating linearly", () => {
    const resampler = new Pcm16To24kResampler();
    // Source positions of output j are 2j/3: 0, 2/3, 4/3, 2, ...
    expect(samplesOf(resampler.push(pcm([0, 300, 600, 900, 1200])))).toEqual([0, 200, 400, 600, 800, 1000]);
  });

  it("gives the same samples whether the stream arrives in one frame or in uneven frames", () => {
    const input = Array.from({ length: 60 }, (_, index) => (index * 37) % 1000);
    const whole = samplesOf(new Pcm16To24kResampler().push(pcm(input)));

    const split = new Pcm16To24kResampler();
    const pieces = [input.slice(0, 7), input.slice(7, 8), input.slice(8, 41), input.slice(41)];
    const joined = pieces.flatMap((piece) => samplesOf(split.push(pcm(piece))));

    expect(joined).toEqual(whole);
  });
});
