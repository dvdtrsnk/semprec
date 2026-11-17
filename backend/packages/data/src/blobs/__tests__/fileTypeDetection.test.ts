import { describe, expect, it } from "vitest";
import { detectFileType } from "../fileTypeDetection.js";

function ftyp(major: string, compatible: string[] = []): Buffer {
  const size = 16 + compatible.length * 4;
  const box = Buffer.alloc(size + 8);
  box.writeUInt32BE(size, 0);
  box.write("ftyp", 4, "latin1");
  box.write(major, 8, "latin1");
  compatible.forEach((brand, index) => box.write(brand, 16 + index * 4, "latin1"));
  return box;
}

function zipEntry(name: string, data = "x", flags = 0): Buffer {
  const header = Buffer.alloc(30);
  header.write("PK\x03\x04", 0, "latin1");
  header.writeUInt16LE(flags, 6);
  header.writeUInt32LE(flags & 0x08 ? 0 : data.length, 18);
  header.writeUInt16LE(name.length, 26);
  return Buffer.concat([header, Buffer.from(name, "latin1"), Buffer.from(data)]);
}

describe("detectFileType", () => {
  it("recognises a PDF, also when the signature sits within the first 1024 bytes", () => {
    expect(detectFileType(Buffer.from("%PDF-1.4"))?.type).toBe("pdf");
    expect(detectFileType(Buffer.concat([Buffer.alloc(1000), Buffer.from("%PDF-1.4")]))?.mimeType).toBe(
      "application/pdf",
    );
    expect(detectFileType(Buffer.concat([Buffer.alloc(1030), Buffer.from("%PDF-1.4")]))).toBeNull();
  });

  it("recognises JPEG and PNG", () => {
    expect(detectFileType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toEqual({ type: "jpg", mimeType: "image/jpeg" });
    expect(detectFileType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toEqual({
      type: "png",
      mimeType: "image/png",
    });
  });

  it.each(["heic", "heix", "heif", "mif1", "msf1", "hevc", "hevx"])("recognises HEIC brand %s", (brand) => {
    expect(detectFileType(ftyp(brand))).toEqual({ type: "heic", mimeType: "image/heic" });
  });

  it("recognises HEIC through a compatible brand", () => {
    expect(detectFileType(ftyp("isom", ["heic"]))?.type).toBe("heic");
  });

  it("recognises m4a by major or compatible brand as audio/mp4", () => {
    expect(detectFileType(ftyp("M4A "))).toEqual({ type: "audio", mimeType: "audio/mp4" });
    expect(detectFileType(ftyp("M4B "))?.mimeType).toBe("audio/mp4");
    expect(detectFileType(ftyp("isom", ["iso2", "M4A "]))).toEqual({ type: "audio", mimeType: "audio/mp4" });
  });

  it("does not recognise an unrelated ISO-BMFF brand", () => {
    expect(detectFileType(ftyp("isom", ["mp41"]))).toBeNull();
  });

  it("recognises mp3 with an ID3 tag and as a bare MPEG Layer III frame", () => {
    expect(detectFileType(Buffer.from("ID3\x04\x00\x00", "latin1"))).toEqual({
      type: "audio",
      mimeType: "audio/mpeg",
    });
    expect(detectFileType(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toEqual({ type: "audio", mimeType: "audio/mpeg" });
  });

  it("does not take a non-Layer-III or reserved-version frame header for mp3", () => {
    expect(detectFileType(Buffer.from([0xff, 0xfd, 0x90, 0x00]))).toBeNull(); // Layer II
    expect(detectFileType(Buffer.from([0xff, 0xeb, 0x90, 0x00]))).toBeNull(); // reserved version
    expect(detectFileType(Buffer.from([0xff, 0x1b]))).toBeNull(); // no frame sync
  });

  it("recognises xlsx and docx from the ZIP entry names", () => {
    const xlsx = Buffer.concat([zipEntry("[Content_Types].xml"), zipEntry("_rels/.rels"), zipEntry("xl/workbook.xml")]);
    const docx = Buffer.concat([zipEntry("[Content_Types].xml"), zipEntry("word/document.xml")]);
    expect(detectFileType(xlsx)?.type).toBe("xlsx");
    expect(detectFileType(docx)?.type).toBe("docx");
  });

  it("walks past a streamed entry whose header carries no size", () => {
    const docx = Buffer.concat([zipEntry("[Content_Types].xml", "data", 0x08), zipEntry("word/document.xml")]);
    expect(detectFileType(docx)?.type).toBe("docx");
  });

  it("gives a ZIP without Office entries no type", () => {
    expect(detectFileType(Buffer.concat([zipEntry("a.txt"), zipEntry("b/c.txt")]))).toBeNull();
  });

  it("returns null for an empty, a truncated and an unknown buffer without throwing", () => {
    expect(detectFileType(Buffer.alloc(0))).toBeNull();
    expect(detectFileType(Buffer.from([0xff]))).toBeNull();
    expect(detectFileType(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(detectFileType(Buffer.from([0x89, 0x50, 0x4e]))).toBeNull();
    expect(detectFileType(Buffer.from("PK\x03\x04", "latin1"))).toBeNull();
    expect(detectFileType(zipEntry("xl/workbook.xml").subarray(0, 40))).toBeNull(); // name cut off
    expect(detectFileType(ftyp("heic").subarray(0, 10))).toBeNull();
    expect(detectFileType(Buffer.from("plain text"))).toBeNull();
  });
});
