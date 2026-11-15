/**
 * Whether `head` starts like an MP3 file: an `ID3` tag, or an MPEG audio frame header (eleven sync bits, a version
 * other than the reserved one, Layer III).
 */
export function looksLikeMp3(head: Buffer): boolean {
  if (head.length >= 3 && head.toString("latin1", 0, 3) === "ID3") return true;
  if (head.length < 2 || head[0] !== 0xff) return false;
  const second = head[1] as number;
  const syncOk = (second & 0xe0) === 0xe0;
  const versionOk = ((second >> 3) & 0x03) !== 0x01; // 01 is reserved
  const layerIii = ((second >> 1) & 0x03) === 0x01;
  return syncOk && versionOk && layerIii;
}

/** Major brands of the ISO-BMFF `ftyp` box that voice recorders and the platform audio APIs give an M4A file. */
const M4A_MAJOR_BRANDS = new Set(["M4A ", "mp42", "isom"]);

/**
 * Detects an audio upload from its leading bytes, never from a declared content type: `audio/mp4` for an ISO-BMFF
 * file whose `ftyp` major brand is `M4A `, `mp42` or `isom`, and `audio/mpeg` for an MP3 (`looksLikeMp3`). Pure and
 * total: short, empty or other input yields `null`. The brand check cannot tell an audio-only MP4 from one with a
 * video track; both are stored as `audio/mp4`.
 */
export function detectAudioMimeType(head: Buffer): "audio/mp4" | "audio/mpeg" | null {
  if (head.length >= 12 && head.toString("latin1", 4, 8) === "ftyp") {
    return M4A_MAJOR_BRANDS.has(head.toString("latin1", 8, 12)) ? "audio/mp4" : null;
  }
  return looksLikeMp3(head) ? "audio/mpeg" : null;
}
