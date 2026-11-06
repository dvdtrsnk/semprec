import type { Pool } from "pg";
import {
  extractAttachmentText,
  isTextExtractableContentType,
  openBlobFromRoots,
  primaryRootForBlob,
  readSempRefContext,
  withTransaction,
  type BlobStorageWriter,
} from "@semprec/data";
import type { AgentImage } from "@semprec/agent-runtime";
import { labeledSempMessageRefSchema, sempMessageRefSchema, type LabeledSempMessageRef } from "@semprec/shared";
import { boundRefSections } from "./refExpansionLimits.js";
import { decodeRefImage, MAX_IMAGE_INPUT_BYTES } from "./refImage.js";

const MAX_TEXT_BLOB_BYTES = 10 * 1024 * 1024;

type StorageRoots = { files: BlobStorageWriter; mailAttachments: BlobStorageWriter };

/** Resolve each stored reference independently; only labels and refs are retained for replay. */
export async function expandSempRefs(
  pool: Pool,
  stored: unknown,
  roots?: StorageRoots,
  signal?: AbortSignal,
): Promise<{ context: LabeledSempMessageRef[]; text: string; images: AgentImage[] }> {
  if (!Array.isArray(stored)) return { context: [], text: "", images: [] };
  const entries: unknown[] = stored;
  const context: LabeledSempMessageRef[] = [];
  const sections: string[] = [];
  const images: AgentImage[] = [];
  for (const entry of entries) {
    signal?.throwIfAborted();
    const old = labeledSempMessageRefSchema.safeParse(entry);
    const fresh = old.success ? null : sempMessageRefSchema.safeParse(entry);
    const ref = old.success ? old.data : fresh?.success ? fresh.data : null;
    if (!ref) {
      sections.push("Reference unavailable.");
      continue;
    }
    let label = old.success ? old.data.label : ref.kind;
    try {
      const observed = await withTransaction(pool, async (client) => {
        const resolved = await readSempRefContext(client, ref);
        const primary = roots && resolved?.blob ? await primaryRootForBlob(client, resolved.blob.id) : null;
        return { resolved, primary };
      });
      signal?.throwIfAborted();
      const { resolved, primary } = observed;
      if (!resolved) {
        sections.push(`${ref.kind}: no longer exists or is unavailable.`);
      } else {
        if (!old.success) label = resolved.label.slice(0, 500);
        let section = `${ref.kind}: ${resolved.state === "trashed" ? "[trashed] " : ""}${resolved.label}\n${JSON.stringify(resolved.details)}`;
        const blob = resolved.blob;
        if (blob) {
          section += `\nAttachment metadata: ${JSON.stringify({ mimeType: blob.mimeType, byteSize: blob.byteSize })}`;
          const image = blob.mimeType.startsWith("image/");
          const plain = blob.mimeType.toLowerCase().split(";")[0]?.trim() === "text/plain";
          const extractable = isTextExtractableContentType(blob.mimeType);
          const cap = image ? MAX_IMAGE_INPUT_BYTES : MAX_TEXT_BLOB_BYTES;
          if (!roots || !primary) section += "\nAttachment unavailable.";
          else if (!/^\d+$/.test(blob.byteSize) || BigInt(blob.byteSize) > BigInt(cap))
            section += "\nAttachment exceeds the size limit.";
          else if (!image && !plain && !extractable) section += "\nAttachment type cannot be extracted.";
          else {
            try {
              const stream = await openBlobFromRoots({
                primary: roots[primary],
                alternate: roots[primary === "files" ? "mailAttachments" : "files"],
                storageKey: blob.storageKey,
              });
              if (!stream) section += "\nAttachment unavailable.";
              else {
                const abort = () => stream.destroy();
                signal?.addEventListener("abort", abort, { once: true });
                try {
                  signal?.throwIfAborted();
                  if (image) {
                    const decoded = await decodeRefImage(stream, signal);
                    signal?.throwIfAborted();
                    if (decoded) images.push(decoded);
                    else section += "\nImage unavailable.";
                  } else {
                    const chunks: Buffer[] = [];
                    let size = 0;
                    for await (const chunk of stream) {
                      signal?.throwIfAborted();
                      const bytes: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                      size += bytes.length;
                      if (size > cap) throw new Error("Attachment exceeds the size limit");
                      chunks.push(bytes);
                    }
                    const bytes = Buffer.concat(chunks, size);
                    const text = plain
                      ? new TextDecoder("utf-8", { fatal: true }).decode(bytes)
                      : await extractAttachmentText(blob.mimeType, bytes);
                    signal?.throwIfAborted();
                    section += text === null ? "\nAttachment type cannot be extracted." : `\n${text}`;
                  }
                } finally {
                  signal?.removeEventListener("abort", abort);
                  stream.destroy();
                }
              }
            } catch {
              signal?.throwIfAborted();
              section += image ? "\nImage unavailable." : "\nAttachment text unavailable.";
            }
          }
        }
        sections.push(section);
      }
    } catch {
      signal?.throwIfAborted();
      sections.push(`${ref.kind}: unavailable.`);
    }
    context.push({ ...ref, label });
  }
  return { context, text: boundRefSections(sections), images };
}
