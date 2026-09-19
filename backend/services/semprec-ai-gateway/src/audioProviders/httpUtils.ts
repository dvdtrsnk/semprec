import { AudioProviderCallError } from "./types.js";

/**
 * Reads a response body with a hard byte cap, independent of any (absent, wrong, or
 * adversarial) Content-Length header, so a pathologically large or malformed provider
 * response can't be buffered into memory wholesale before parsing. Shared by every audio
 * provider adapter — errors never carry the raw response body, matching
 * AudioProviderCallError's documented contract.
 */
export async function readJsonBodyWithSizeCap(res: Response, providerName: string, maxBytes: number): Promise<unknown> {
  const reader = res.body?.getReader();
  if (!reader) throw new AudioProviderCallError(`${providerName} response body stream was unavailable`);

  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      // A failed cancel() must not replace the size-cap error below with an unrelated rejection.
      await reader.cancel().catch(() => {});
      throw new AudioProviderCallError(`${providerName} response body exceeded the maximum allowed size`);
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"));
  } catch {
    throw new AudioProviderCallError(`${providerName} response body was not valid JSON`);
  }
}
