export type DetectedFileType = "pdf" | "xlsx" | "docx" | "jpg" | "png" | "heic" | "audio";

export interface DetectedFile {
  type: DetectedFileType;
  mimeType: string;
}

/** How many leading bytes `detectFileType` needs to see: the ZIP entry-name scan reads this far. */
export const FILE_TYPE_DETECTION_HEAD_BYTES = 64 * 1024;

const PDF_SEARCH_BYTES = 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ZIP_LOCAL_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ZIP_LOCAL_HEADER_BYTES = 30;
const HEIC_BRANDS = new Set(["heic", "heix", "heif", "mif1", "msf1", "hevc", "hevx"]);
const M4A_BRANDS = new Set(["M4A ", "M4B "]);

/** ISO-BMFF brands of the `ftyp` box at the start of `head`: the major brand, then the compatible ones. */
function isoBmffBrands(head: Buffer): string[] | null {
  if (head.length < 12 || head.toString("latin1", 4, 8) !== "ftyp") return null;
  const boxSize = head.readUInt32BE(0);
  const end = Math.min(boxSize >= 16 ? boxSize : head.length, head.length);
  const brands = [head.toString("latin1", 8, 12)];
  // Bytes 12..16 are the minor version, not a brand.
  for (let offset = 16; offset + 4 <= end; offset += 4) {
    brands.push(head.toString("latin1", offset, offset + 4));
  }
  return brands;
}

function isMp3(head: Buffer): boolean {
  if (head.length >= 3 && head.toString("latin1", 0, 3) === "ID3") return true;
  if (head.length < 2 || head[0] !== 0xff) return false;
  const second = head[1] as number;
  const syncOk = (second & 0xe0) === 0xe0;
  const versionOk = ((second >> 3) & 0x03) !== 0x01; // 01 is reserved
  const layerIii = ((second >> 1) & 0x03) === 0x01;
  return syncOk && versionOk && layerIii;
}

/** Office type from the entry names of the ZIP's local file headers, or null for a plain ZIP. */
function officeTypeFromZip(head: Buffer): "xlsx" | "docx" | null {
  let offset = 0;
  while (offset + ZIP_LOCAL_HEADER_BYTES <= head.length && head.subarray(offset, offset + 4).equals(ZIP_LOCAL_HEADER)) {
    const flags = head.readUInt16LE(offset + 6);
    const compressedSize = head.readUInt32LE(offset + 18);
    const nameLength = head.readUInt16LE(offset + 26);
    const extraLength = head.readUInt16LE(offset + 28);
    const nameStart = offset + ZIP_LOCAL_HEADER_BYTES;
    if (nameStart + nameLength > head.length) return null;
    const name = head.toString("latin1", nameStart, nameStart + nameLength);
    if (name.startsWith("xl/")) return "xlsx";
    if (name.startsWith("word/")) return "docx";
    const dataStart = nameStart + nameLength + extraLength;
    // A streamed entry (bit 3) records its size after the data, so the header says 0: find the next header instead.
    const next =
      (flags & 0x08) !== 0 && compressedSize === 0
        ? head.indexOf(ZIP_LOCAL_HEADER, dataStart)
        : dataStart + compressedSize;
    if (next < 0 || next <= offset) return null;
    offset = next;
  }
  return null;
}

/** The Files `type` value each stored mime type files as; `audio/*` is handled separately. */
const FILES_TYPE_BY_MIME_TYPE: ReadonlyMap<string, DetectedFileType> = new Map([
  ["application/pdf", "pdf"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/heic", "heic"],
]);

/**
 * The Files `type` value a stored blob's mime type files as, or null when no Files type matches it.
 * A caller still checks that the value is one of the Files `type` options before it writes it.
 */
export function filesTypeForMimeType(mimeType: string): DetectedFileType | null {
  if (mimeType.startsWith("audio/")) return "audio";
  return FILES_TYPE_BY_MIME_TYPE.get(mimeType) ?? null;
}

/**
 * Detects a file's type from its leading bytes (at most the first `FILE_TYPE_DETECTION_HEAD_BYTES`
 * are read), never from a declared content type or extension. Pure and total: short, empty or
 * malformed input yields `null`, never an exception.
 */
export function detectFileType(head: Buffer): DetectedFile | null {
  if (head.subarray(0, PDF_SEARCH_BYTES).includes("%PDF-", 0, "latin1")) {
    return { type: "pdf", mimeType: "application/pdf" };
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { type: "jpg", mimeType: "image/jpeg" };
  }
  if (head.length >= PNG_SIGNATURE.length && head.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return { type: "png", mimeType: "image/png" };
  }
  const brands = isoBmffBrands(head);
  if (brands) {
    if (brands.some((brand) => M4A_BRANDS.has(brand))) return { type: "audio", mimeType: "audio/mp4" };
    if (brands.some((brand) => HEIC_BRANDS.has(brand))) return { type: "heic", mimeType: "image/heic" };
    return null;
  }
  if (isMp3(head)) return { type: "audio", mimeType: "audio/mpeg" };
  if (head.length >= 4 && head.subarray(0, 4).equals(ZIP_LOCAL_HEADER)) {
    const office = officeTypeFromZip(head.subarray(0, FILE_TYPE_DETECTION_HEAD_BYTES));
    if (office === "xlsx") {
      return { type: "xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
    }
    if (office === "docx") {
      return { type: "docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
    }
  }
  return null;
}
