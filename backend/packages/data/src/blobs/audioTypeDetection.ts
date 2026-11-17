/** An `ID3` tag, or an MPEG frame header: eleven sync bits, a non-reserved version, Layer III. */
export function looksLikeMp3(head: Buffer): boolean {
  if (head.length >= 3 && head.toString("latin1", 0, 3) === "ID3") return true;
  if (head.length < 2 || head[0] !== 0xff) return false;
  const second = head[1] as number;
  const syncOk = (second & 0xe0) === 0xe0;
  const versionOk = ((second >> 3) & 0x03) !== 0x01; // 01 is reserved
  const layerIii = ((second >> 1) & 0x03) === 0x01;
  return syncOk && versionOk && layerIii;
}

/** `ftyp` major brands voice recorders and platform audio APIs give an M4A file. */
const M4A_MAJOR_BRANDS = new Set(["M4A ", "mp42", "isom"]);

/** Never throws. The brand check cannot tell audio-only MP4 from one with video; both become `audio/mp4`. */
export function detectAudioMimeType(head: Buffer): "audio/mp4" | "audio/mpeg" | null {
  if (head.length >= 12 && head.toString("latin1", 4, 8) === "ftyp") {
    return M4A_MAJOR_BRANDS.has(head.toString("latin1", 8, 12)) ? "audio/mp4" : null;
  }
  return looksLikeMp3(head) ? "audio/mpeg" : null;
}
