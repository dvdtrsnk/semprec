import { describe, expect, it } from "vitest";
import { detectAudioMimeType, looksLikeMp3 } from "../audioTypeDetection.js";

function ftyp(major: string, length = 24): Buffer {
  const box = Buffer.alloc(length);
  box.writeUInt32BE(length, 0);
  box.write("ftyp", 4, "latin1");
  box.write(major, 8, "latin1");
  return box;
}

describe("detectAudioMimeType (issue gh-1963)", () => {
  it.each(["M4A ", "mp42", "isom"])("recognises the ISO-BMFF major brand %s as audio/mp4", (brand) => {
    expect(detectAudioMimeType(ftyp(brand))).toBe("audio/mp4");
  });

  it("reads the major brand only, not the compatible brands", () => {
    const head = ftyp("heic");
    head.write("M4A ", 16, "latin1");
    expect(detectAudioMimeType(head)).toBeNull();
  });

  it("refuses an ISO-BMFF box of another brand, and one cut off before the brand ends", () => {
    expect(detectAudioMimeType(ftyp("qt  "))).toBeNull();
    expect(detectAudioMimeType(ftyp("M4A ", 11).subarray(0, 11))).toBeNull();
  });

  it("does not take a box whose type is not ftyp for an ISO-BMFF file", () => {
    const head = ftyp("M4A ");
    head.write("moov", 4, "latin1");
    expect(detectAudioMimeType(head)).toBeNull();
  });

  it("recognises an MP3 by its ID3 tag", () => {
    expect(detectAudioMimeType(Buffer.from("ID3\x03\x00"))).toBe("audio/mpeg");
    expect(detectAudioMimeType(Buffer.from("ID3"))).toBe("audio/mpeg");
  });

  it("recognises an MP3 by an MPEG Layer III frame header", () => {
    expect(detectAudioMimeType(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBe("audio/mpeg");
    expect(detectAudioMimeType(Buffer.from([0xff, 0xf3, 0x90, 0x00]))).toBe("audio/mpeg");
  });

  it("refuses a frame header with the reserved version, another layer, or too few sync bits", () => {
    expect(looksLikeMp3(Buffer.from([0xff, 0xeb]))).toBe(false); // reserved version 01
    expect(looksLikeMp3(Buffer.from([0xff, 0xfd]))).toBe(false); // Layer II
    expect(looksLikeMp3(Buffer.from([0xff, 0xdb]))).toBe(false); // ten sync bits
    expect(looksLikeMp3(Buffer.from([0xfe, 0xfb]))).toBe(false);
  });

  it("never takes a JPEG, a PDF or an executable for audio", () => {
    expect(detectAudioMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBeNull();
    expect(detectAudioMimeType(Buffer.from("%PDF-1.7"))).toBeNull();
    expect(detectAudioMimeType(Buffer.from("MZ\x90\x00"))).toBeNull();
  });

  it("answers null for empty and one-byte input without throwing", () => {
    expect(detectAudioMimeType(Buffer.alloc(0))).toBeNull();
    expect(detectAudioMimeType(Buffer.from([0xff]))).toBeNull();
  });
});
