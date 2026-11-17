import { AudioProviderCallError } from "./types.js";

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Hard byte cap regardless of Content-Length. Errors never carry the raw body. */
export async function readJsonBodyWithSizeCap(res: Response, providerName: string, maxBytes: number): Promise<unknown> {
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = res.body?.getReader();
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
