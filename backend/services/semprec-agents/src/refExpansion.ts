import type { Pool } from "pg";
import type { Readable } from "node:stream";
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
import {
  BlobReadCleanupError,
  labeledSempMessageRefSchema,
  sempMessageRefSchema,
  settleBlobReadStream,
  type LabeledSempMessageRef,
} from "@semprec/shared";
import { boundRefSections } from "./refExpansionLimits.js";
import { decodeRefImage, MAX_IMAGE_INPUT_BYTES } from "./refImage.js";

const MAX_TEXT_BLOB_BYTES = 10 * 1024 * 1024;

type StorageRoots = { files: BlobStorageWriter; mailAttachments: BlobStorageWriter };

/** Consume a transferred stream without leaving an iterator return waiting on destruction. */
async function readRefBytes(stream: Readable, cap: number, signal?: AbortSignal): Promise<Buffer> {
  const errors: unknown[] = [];
  const chunks: Buffer[] = [];
  let size = 0;
  let result: { bytes: Buffer } | { error: unknown } | undefined;
  let resolve!: () => void;
  const terminal = new Promise<void>((done) => {
    resolve = done;
  });
  const detachTerminals = () => {
    stream.off("data", data);
    stream.off("end", end);
    stream.off("close", close);
    signal?.removeEventListener("abort", abort);
  };
  const finish = (outcome: { bytes: Buffer } | { error: unknown }) => {
    if (result) return;
    result = outcome;
    stream.pause();
    detachTerminals();
    resolve();
  };
  const data = (raw: unknown) => {
    if (!(raw instanceof Uint8Array)) return finish({ error: new Error("Invalid attachment byte stream") });
    if (size + raw.byteLength > cap) return finish({ error: new Error("Attachment exceeds the size limit") });
    const bytes = Buffer.from(raw);
    size += bytes.length;
    chunks.push(bytes);
  };
  const end = () => finish({ bytes: Buffer.concat(chunks, size) });
  const error = (value: unknown) => {
    if (errors.length < 2 && !errors.some((entry) => entry === value)) errors.push(value);
    finish({ error: value });
  };
  const close = () => finish({ error: stream.errored ?? new Error("Attachment closed before read completed") });
  const abort = () => finish({ error: signal?.reason });
  stream.on("error", error);
  stream.once("end", end);
  stream.once("close", close);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  else if (stream.closed || stream.destroyed || stream.readableEnded) close();
  else stream.on("data", data);
  await terminal;
  if (!result) throw new Error("Attachment read has no outcome");
  const outcome: { bytes: Buffer } | { error: unknown } = result;
  await settleBlobReadStream(stream, {}, "error" in outcome ? { error: outcome.error } : undefined, errors, () =>
    stream.off("error", error),
  );
  if ("error" in outcome) throw outcome.error;
  signal?.throwIfAborted();
  return outcome.bytes;
}

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
    let label = old.success ? old.data.label : "";
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
                signal,
              });
              if (!stream) section += "\nAttachment unavailable.";
              else {
                const bytes = await readRefBytes(stream, cap, signal);
                if (image) {
                  const decoded = await decodeRefImage(bytes, signal);
                  signal?.throwIfAborted();
                  if (decoded) images.push(decoded);
                  else section += "\nImage unavailable.";
                } else {
                  const text = plain
                    ? new TextDecoder("utf-8", { fatal: true }).decode(bytes)
                    : await extractAttachmentText(blob.mimeType, bytes);
                  signal?.throwIfAborted();
                  section += text === null ? "\nAttachment type cannot be extracted." : `\n${text}`;
                }
              }
            } catch (error) {
              if (error instanceof BlobReadCleanupError) throw error;
              signal?.throwIfAborted();
              section += image ? "\nImage unavailable." : "\nAttachment text unavailable.";
            }
          }
        }
        sections.push(section);
      }
    } catch (error) {
      if (error instanceof BlobReadCleanupError) throw error;
      signal?.throwIfAborted();
      sections.push(`${ref.kind}: unavailable.`);
    }
    context.push({ ...ref, label });
  }
  return { context, text: boundRefSections(sections), images };
}
