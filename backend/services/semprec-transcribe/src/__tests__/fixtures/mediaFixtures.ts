import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Test-only media fixtures and probes for the integration-tier tests that run the real binaries.
 * Most fixtures come from ffmpeg's `lavfi` test sources; spoken-markers.wav is the owned offline fixture below.
 */

export const FIXTURE_CREATION_TIME = "2024-03-01T12:00:00Z";

// Owned offline fixture: macOS `say -v Samantha -o <temp.aiff> 'Alpha. [[slnc 700]] Bravo.'`,
// then `ffmpeg -i <temp.aiff> -ac 1 -ar 16000 -c:a pcm_s16le spoken-markers.wav`.
// PCM s16le, 16 kHz, mono; SHA-256 3c39a09e123866256fd03a11dfbbe727d06ffe0983ad184ce469f374f1560a2a.
// Alpha is at 0–0.43 s and Bravo at 1.35–1.81 s; tests consume these bytes without TTS.
const spokenFixturePath = fileURLToPath(new URL("./spoken-markers.wav", import.meta.url));

export function generateSpokenMedia(lateVideo: boolean): Promise<Buffer> {
  const inputs = lateVideo
    ? ["-f", "lavfi", "-i", "testsrc=size=64x64:rate=5:duration=3.1", "-itsoffset", "1", "-i", spokenFixturePath]
    : ["-i", spokenFixturePath];
  const output = lateVideo
    ? ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-profile:a", "aac_low", "-f", "matroska"]
    : ["-c:a", "aac", "-profile:a", "aac_low", "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof"];
  return runToBuffer("ffmpeg", ["-y", "-loglevel", "error", ...inputs, ...output, "pipe:1"]);
}

export async function speechWindow(path: string, seconds: number): Promise<Buffer> {
  return runToBuffer("ffmpeg", [
    "-loglevel",
    "error",
    "-ss",
    String(seconds),
    "-i",
    path,
    "-t",
    "0.4",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-f",
    "s16le",
    "pipe:1",
  ]);
}

export async function decodeSpeech(path: string): Promise<Buffer> {
  return runToBuffer("ffmpeg", ["-loglevel", "error", "-i", path, "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"]);
}

export async function probeAacProfile(path: string): Promise<string> {
  const output = await runToBuffer("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=profile",
    path,
  ]);
  const parsed = z
    .object({ streams: z.array(z.object({ profile: z.string() })) })
    .parse(JSON.parse(output.toString("utf8")));
  const stream = parsed.streams[0];
  if (!stream) throw new Error("Missing AAC stream");
  return stream.profile;
}

/** Compare decoded samples with a small codec-delay allowance. */
export function speechSimilarity(first: Buffer, second: Buffer): { score: number; lagSamples: number } {
  const a = first.length / 2;
  const b = second.length / 2;
  let best = 0;
  let lagSamples = 0;
  for (let lag = -1600; lag <= 1600; lag++) {
    let sum = 0,
      aa = 0,
      bb = 0;
    for (let i = 1600; i < Math.min(a, b) - 1600; i++) {
      const x = first.readInt16LE(i * 2);
      const y = second.readInt16LE((i + lag) * 2);
      sum += x * y;
      aa += x * x;
      bb += y * y;
    }
    if (aa && bb) {
      const score = Math.abs(sum) / Math.sqrt(aa * bb);
      if (score > best) {
        best = score;
        lagSamples = lag;
      }
    }
  }
  return { score: best, lagSamples };
}

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

/**
 * A three-second streamed Matroska recording with a video track whose audio track starts one second
 * late (`-itsoffset`) and lasts two. Matroska because a fragmented MP4 piped from ffmpeg does not
 * keep the offset.
 */
export function generateLateAudioVideoFixture(): Promise<Buffer> {
  return runToBuffer("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=64x64:rate=5:duration=3",
    "-itsoffset",
    "1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-f",
    "matroska",
    "pipe:1",
  ]);
}

/** Two distinguishable half-second tones, optionally in a video with a late audio track. */
export function generateSeekFixture(lateVideo: boolean): Promise<Buffer> {
  const video = lateVideo ? ["-f", "lavfi", "-i", "testsrc=size=64x64:rate=5:duration=3", "-itsoffset", "1"] : [];
  const audio = ["-f", "lavfi", "-i", "aevalsrc=if(lt(t\\,1)\\,0.2*sin(2*PI*440*t)\\,0.2*sin(2*PI*880*t)):s=16000:d=2"];
  const output = lateVideo
    ? ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-f", "matroska"]
    : ["-c:a", "aac", "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof"];
  return runToBuffer("ffmpeg", ["-y", "-loglevel", "error", ...video, ...audio, ...output, "pipe:1"]);
}

/** Measures zero crossings of a decoded 200 ms seek window, providing a distinct content marker. */
export async function seekToneFrequency(path: string, seconds: number): Promise<number> {
  const bytes = await runToBuffer("ffmpeg", [
    "-loglevel",
    "error",
    "-ss",
    String(seconds),
    "-i",
    path,
    "-t",
    "0.2",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-f",
    "s16le",
    "pipe:1",
  ]);
  let crossings = 0;
  for (let offset = 2; offset + 1 < bytes.length; offset += 2) {
    if (bytes.readInt16LE(offset - 2) <= 0 && bytes.readInt16LE(offset) > 0) crossings++;
  }
  return crossings / (bytes.length / 2 / 16000);
}

/** A one-second Ogg Opus recording, a type that is not directly playable on iOS. */
export function generateOggFixture(): Promise<Buffer> {
  return runToBuffer("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1",
    "-c:a",
    "libopus",
    "-f",
    "ogg",
    "pipe:1",
  ]);
}

/** The codec, channel count and bit rate of a file's first audio stream, as ffprobe reports them. */
export async function probeAudioStream(
  path: string,
): Promise<{ codecName: string; channels: number; bitRate: number }> {
  const output = await runToBuffer("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_entries",
    "stream=codec_name,channels,bit_rate",
    "-select_streams",
    "a",
    path,
  ]);
  const stream = z
    .object({
      streams: z.array(z.object({ codec_name: z.string(), channels: z.number(), bit_rate: z.string().optional() })),
    })
    .parse(JSON.parse(output.toString("utf8"))).streams[0];
  if (!stream) throw new Error(`'${path}' has no audio stream`);
  return { codecName: stream.codec_name, channels: stream.channels, bitRate: Number(stream.bit_rate ?? 0) };
}

/**
 * A three-second streamed WebM/Matroska recording, the shape browser `MediaRecorder` output takes.
 * Piped straight to `pipe:1` rather than muxed to a seekable file, its container header carries no
 * `format.duration` — unlike `generateMp4Fixture`, which does store one even when fragmented.
 */
export function generateWebmFixture(): Promise<Buffer> {
  return runToBuffer("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=duration=3",
    "-c:a",
    "libopus",
    "-f",
    "webm",
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
