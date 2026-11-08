import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { decodeRefImage, MAX_IMAGE_INPUT_BYTES, MAX_IMAGE_OUTPUT_BYTES, MAX_IMAGE_SIDE } from "../refImage.js";

describe("ephemeral reference images", () => {
  it.each(["jpeg", "png", "webp", "gif"] as const)("decodes and bounds %s input", async (format) => {
    const input = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "#667788" } })
      .toFormat(format)
      .toBuffer();
    const result = await decodeRefImage(input);
    expect(result?.mimeType).toBe("image/jpeg");
    const output = Buffer.from(result?.data ?? "", "base64");
    expect(output.length).toBeLessThanOrEqual(MAX_IMAGE_OUTPUT_BYTES);
    const metadata = await sharp(output).metadata();
    expect(metadata.width).toBe(MAX_IMAGE_SIDE);
    expect(metadata.height).toBe(800);
  });

  it("rejects unsupported, corrupt and oversized bytes", async () => {
    expect(await decodeRefImage(Buffer.from("<svg/>"))).toBeNull();
    expect(await decodeRefImage(Buffer.from([0xff, 0xd8, 0xff, 0x00]))).toBeNull();
    expect(await decodeRefImage(Buffer.alloc(MAX_IMAGE_INPUT_BYTES + 1))).toBeNull();
  });

  it("rejects an image whose decoded dimensions exceed the pixel budget", async () => {
    const input = await sharp({ create: { width: 6000, height: 6000, channels: 3, background: "#123456" } })
      .png()
      .toBuffer();
    expect(await decodeRefImage(input)).toBeNull();
  });

  it("refuses a buffer when already cancelled", async () => {
    const signal = AbortSignal.abort();
    expect(await decodeRefImage(Buffer.from("unused"), signal)).toBeNull();
  });
});
