import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { z } from "zod";

/** Media fixtures for tests that run the real binaries, mostly from ffmpeg's `lavfi` sources. */

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

/** A one-second fragmented mp4; `creationTime` becomes the `creation_time` tag. */
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

/** Audio starting one second late in a video; Matroska because a piped fragmented MP4 drops the offset. */
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

/** Not directly playable on iOS. */
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

/** Like browser `MediaRecorder` output: piped, so the header carries no `format.duration`. */
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

/** Unlike mp4, an ID3v2 tag keeps a free-text `creation_time` verbatim. */
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
 * `inputSampleRate` comes from the Opus identification header (RFC 7845 §5.1); ffprobe reports
 * every Opus stream at 48 kHz.
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

/** A seekable M4A with an exact duration; silence at 8 kHz mono keeps long ones quick to encode. */
export async function generateM4aFixture(seconds: number, options: { creationTime?: string } = {}): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), "alldots-m4a-fixture-"));
  try {
    const path = join(directory, "note.m4a");
    const metadata = options.creationTime ? ["-metadata", `creation_time=${options.creationTime}`] : [];
    await runToBuffer("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `anullsrc=r=8000:cl=mono:d=${seconds}`,
      ...metadata,
      "-c:a",
      "aac",
      "-b:a",
      "16k",
      "-f",
      "ipod",
      path,
    ]);
    return await readFile(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** `exifOrientation` (JPEG only): 6 is a quarter turn, so 300 x 200 stored is shown 200 x 300. */
export async function generateImageFixture(options: {
  width: number;
  height: number;
  format: "jpeg" | "png";
  exifOrientation?: number;
}): Promise<Buffer> {
  const bytes = await runToBuffer("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=${options.width}x${options.height}`,
    "-frames:v",
    "1",
    "-f",
    options.format === "jpeg" ? "mjpeg" : "image2pipe",
    ...(options.format === "png" ? ["-c:v", "png"] : []),
    "pipe:1",
  ]);
  if (options.exifOrientation === undefined) return bytes;
  // An APP1 segment holding a one-entry little-endian TIFF directory: tag 0x0112 (Orientation), type SHORT, one value.
  const tiff = Buffer.concat([
    Buffer.from("II*\0", "latin1"),
    Buffer.from([8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, options.exifOrientation, 0, 0, 0, 0, 0, 0, 0]),
  ]);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const segment = Buffer.concat([Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
  return Buffer.concat([bytes.subarray(0, 2), segment, bytes.subarray(2)]);
}

/** A small PNG declaring a huge canvas, which decoders can only read by allocating the whole frame. */
export function generateHugeCanvasPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 0, 0, 0, 0], 8); // 8-bit grayscale, no interlace
  const row = Buffer.alloc(width + 1); // filter type 0, then `width` zero pixels
  const rows = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
