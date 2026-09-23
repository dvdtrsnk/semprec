import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { z } from "zod";

/**
 * Test-only media fixtures and probes for the integration-tier tests that run the real binaries.
 * Fixtures come from ffmpeg's `lavfi` test sources, streamed straight to a buffer — no binary
 * fixture checked into git.
 */

export const FIXTURE_CREATION_TIME = "2024-03-01T12:00:00Z";

function runToBuffer(command: "ffmpeg" | "ffprobe", args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`${command} failed: ${Buffer.concat(stderrChunks).toString("utf8")}`));
    });
  });
}

/**
 * A one-second fragmented-mp4 recording. `withVideo` adds a video track next to the audio one (the
 * "video input with an audio track" case); `creationTime` becomes the container's `creation_time`
 * tag, which is left out entirely when omitted.
 */
export function generateMp4Fixture(options: { withVideo?: boolean; creationTime?: string } = {}): Promise<Buffer> {
  const inputs = options.withVideo
    ? [
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=64x64:rate=5:duration=1",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
      ]
    : ["-f", "lavfi", "-i", "sine=frequency=440:duration=1"];
  const metadata = options.creationTime ? ["-metadata", `creation_time=${options.creationTime}`] : [];
  const codecArgs = options.withVideo
    ? ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"]
    : ["-c:a", "aac"];
  return runToBuffer("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    ...inputs,
    ...metadata,
    ...codecArgs,
    "-f",
    "mp4",
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof",
    "pipe:1",
  ]);
}

/** A one-second MP3 recording. Unlike mp4, which only stores a real timestamp, its ID3v2 tag keeps a free-text `creation_time` verbatim. */
export function generateMp3Fixture(creationTimeTag: string): Promise<Buffer> {
  return runToBuffer("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1",
    "-metadata",
    `creation_time=${creationTimeTag}`,
    "-c:a",
    "libmp3lame",
    "-f",
    "mp3",
    "pipe:1",
  ]);
}

const audioStreamsSchema = z.object({
  streams: z.array(z.object({ codec_name: z.string(), channels: z.number() })),
});

/**
 * Reads back what a normalized file actually is. `inputSampleRate` comes from the Ogg Opus
 * identification header (RFC 7845 §5.1), the one place the rate ffmpeg resampled to before
 * encoding survives — ffprobe reports every Opus stream at its fixed 48 kHz decode rate.
 */
export async function probeNormalizedAudio(
  path: string,
): Promise<{ codecName: string; channels: number; inputSampleRate: number }> {
  const output = await runToBuffer("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_entries",
    "stream=codec_name,channels",
    "-select_streams",
    "a",
    path,
  ]);
  const stream = audioStreamsSchema.parse(JSON.parse(output.toString("utf8"))).streams[0];
  if (!stream) throw new Error(`'${path}' has no audio stream`);
  const bytes = await readFile(path);
  const header = bytes.indexOf("OpusHead");
  if (header === -1) throw new Error(`'${path}' has no Opus identification header`);
  return { codecName: stream.codec_name, channels: stream.channels, inputSampleRate: bytes.readUInt32LE(header + 12) };
}
