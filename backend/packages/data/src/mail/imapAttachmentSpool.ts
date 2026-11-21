// Downloads a pass's attachments to local temp files before any transaction opens, so ingest reads local bytes
// instead of the provider connection.
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { ClassifiedAttachment } from "./attachments.js";
import { logger } from "./logger.js";
import { AttachmentCapExceededError } from "./providerTypes.js";

export interface AttachmentSpool {
  /** The attachments with `openStream` reading the spooled copy; a capped one rethrows its cap error from there. */
  spool(attachments: ClassifiedAttachment[]): Promise<ClassifiedAttachment[]>;
  /** Never rejects: a removal failure is logged, so it cannot replace the pass's own outcome. */
  remove(): Promise<void>;
}

export function createAttachmentSpool(): AttachmentSpool {
  let directory: Promise<string> | undefined;
  let count = 0;
  return {
    async spool(attachments) {
      const spooled: ClassifiedAttachment[] = [];
      for (const attachment of attachments) {
        directory ??= mkdtemp(join(tmpdir(), "semprec-imap-pass-"));
        const path = join(await directory, String(count++));
        try {
          await pipeline(await attachment.openStream(), createWriteStream(path));
          spooled.push({ ...attachment, openStream: () => createReadStream(path) });
        } catch (err) {
          if (!(err instanceof AttachmentCapExceededError)) throw err;
          spooled.push({
            ...attachment,
            openStream: () => {
              throw err;
            },
          });
        }
      }
      return spooled;
    },
    async remove() {
      if (!directory) return;
      try {
        await rm(await directory, { recursive: true, force: true });
      } catch (err) {
        logger.warn(
          { errorName: err instanceof Error ? err.name : "non_error" },
          "Removing spooled attachments failed",
        );
      }
    },
  };
}
