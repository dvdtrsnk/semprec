import { logger } from "./logger.js";

/** Confines unknown failures to the finite provider or MIME operation that owns them. */
export async function privateSendOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    // The operation has finished its own cleanup before its original failure leaves this boundary.
    void error;
    // eslint-disable-next-line preserve-caught-error
    throw new Error("Mail send provider operation failed");
  }
}

/** A cleanup diagnostic cannot turn an acknowledged send into a failure. */
export function reportSendCleanupFailure(
  stage: "graph-send-response" | "graph-draft-delete" | "send-response" | "graph-upload-response",
): void {
  try {
    logger.warn({ stage }, "Mail send cleanup failed");
  } catch (error) {
    void error;
  }
}

/** Releases a response reader after its bounded read, preserving both failure values until cleanup settles. */
export async function readSendBody(response: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  let primary: { value: unknown } | undefined;
  const secondary: unknown[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      if (size + chunk.length > limit) {
        chunks.push(chunk.subarray(0, limit - size));
        truncated = true;
        break;
      }
      chunks.push(chunk);
      size += chunk.length;
    }
  } catch (error) {
    primary = { value: error };
  }
  try {
    await reader.cancel();
  } catch (error) {
    secondary.push(error);
  }
  try {
    reader.releaseLock();
  } catch (error) {
    secondary.push(error);
  }
  if (secondary.length > 0) reportSendCleanupFailure("send-response");
  if (primary) throw primary.value;
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}
