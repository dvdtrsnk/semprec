import sharp from "sharp";
import type { AgentImage } from "@semprec/agent-runtime";

export const MAX_IMAGE_INPUT_BYTES = 16 * 1024 * 1024;
export const MAX_IMAGE_INPUT_PIXELS = 32_000_000;
export const MAX_IMAGE_SIDE = 1600;
export const MAX_IMAGE_OUTPUT_BYTES = 256 * 1024;

function supportedSignature(bytes: Buffer): boolean {
  return (
    bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ||
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
    (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") ||
    ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))
  );
}

/** Decode one authorized image; failures leave no persistent derivative. */
export async function decodeRefImage(input: Buffer, signal?: AbortSignal): Promise<AgentImage | null> {
  try {
    if (input.length > MAX_IMAGE_INPUT_BYTES || signal?.aborted) return null;
    if (!supportedSignature(input) || signal?.aborted) return null;
    const image = sharp(input, { failOn: "warning", limitInputPixels: MAX_IMAGE_INPUT_PIXELS, pages: 1 });
    const output = await image
      .rotate()
      .resize({ width: MAX_IMAGE_SIDE, height: MAX_IMAGE_SIDE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 75 })
      .timeout({ seconds: 5 })
      .toBuffer();
    if (signal?.aborted || output.length > MAX_IMAGE_OUTPUT_BYTES) return null;
    return { type: "image", data: output.toString("base64"), mimeType: "image/jpeg" };
  } catch {
    return null;
  }
}
