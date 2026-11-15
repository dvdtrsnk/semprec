import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  audioKindForDuration,
  enqueueInboxVoiceNoteTranscribe,
  getInboxAttachment,
  INBOX_ATTACHMENT_UNREADABLE,
  inboxAttachmentMetadataPayloadSchema,
  readInboxAttachmentForMetadata,
  recordInboxAttachmentMetadata,
  tenantBlobStorageKey,
  withTransaction,
  type BlobStorageWriter,
  type InboxAttachmentMetadata,
  type InboxAttachmentMetadataSource,
  type RecordedInboxAttachmentMetadata,
} from "@semprec/data";
import { logger } from "./logger.js";
import {
  discardStoredImage,
  downloadToTempFile,
  MediaToolError,
  probeImage,
  probeMedia,
  removeTempFile,
  renderImageJpeg,
  type StoredMediaResult,
} from "./mediaNormalization.js";

/** The long side of the preview an Inbox card shows, in pixels (shown at 64 pt on retina screens). */
const PREVIEW_LONG_SIDE_PIXELS = 128;
/** The longest side of the reduced copy the assistant reads, in pixels. */
const REDUCED_LONG_SIDE_PIXELS = 1568;

/** What the job found for one attachment, and the images it wrote to blob storage and has not recorded yet. */
interface AttachmentFacts {
  metadata: InboxAttachmentMetadata;
  thumbnail: StoredMediaResult | null;
  reduced: StoredMediaResult | null;
}

/** `metadata` for a file `ffprobe` or `ffmpeg` could not read: the failure's code and nothing of the file. */
const UNREADABLE_FACTS: AttachmentFacts = {
  metadata: { error: INBOX_ATTACHMENT_UNREADABLE, pages: null },
  thumbnail: null,
  reduced: null,
};

/** Where the two derived images of one run are written; fresh for each run, so two runs never share a key. */
interface ImageKeys {
  thumbnail: string;
  reduced: string;
}

function isImage(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

function isAudio(mimeType: string): boolean {
  return mimeType.startsWith("audio/");
}

function toDerivedImage(image: StoredMediaResult) {
  return {
    mimeType: "image/jpeg",
    byteSize: image.byteSize,
    storageKey: image.storageKey,
    contentHash: image.contentHash,
  };
}

/** The size of a photo, its 128 px preview and its reduced copy, the two images already in blob storage. */
async function readImageFacts(
  inputPath: string,
  keys: ImageKeys,
  blobStorage: BlobStorageWriter,
): Promise<AttachmentFacts> {
  const { width, height } = await probeImage(inputPath);
  const thumbnail = await renderImageJpeg(inputPath, PREVIEW_LONG_SIDE_PIXELS, blobStorage, keys.thumbnail);
  try {
    const reduced = await renderImageJpeg(inputPath, REDUCED_LONG_SIDE_PIXELS, blobStorage, keys.reduced);
    return { metadata: { width, height, pages: null }, thumbnail, reduced };
  } catch (err) {
    await discardStoredImage(blobStorage, thumbnail.storageKey);
    throw err;
  }
}

/** The length of an audio note, when it was recorded if its file says, and whether it is a voice note or a recording. */
async function readAudioFacts(inputPath: string): Promise<AttachmentFacts> {
  const { durationSeconds, creationTime } = await probeMedia(inputPath);
  // A container with no duration cannot be classified; it is as good as unreadable.
  if (durationSeconds === null) return UNREADABLE_FACTS;
  return {
    metadata: {
      durationSeconds,
      audioKind: audioKindForDuration(durationSeconds),
      ...(creationTime === null ? {} : { recordedAt: creationTime }),
      pages: null,
    },
    thumbnail: null,
    reduced: null,
  };
}

/**
 * Reads the facts of one attachment from its bytes. A file `ffprobe` or `ffmpeg` could not read (`MediaToolError`)
 * is the `UNREADABLE_FACTS`; everything else, such as the bytes missing from storage or `ffprobe` not starting, is
 * not a property of the file and propagates, so the job is retried. A PDF or an office document has no facts but the
 * null `pages`, and is not opened.
 */
async function readFacts(
  source: InboxAttachmentMetadataSource,
  keys: ImageKeys,
  blobStorage: BlobStorageWriter,
): Promise<AttachmentFacts> {
  const image = isImage(source.mimeType);
  if (!image && !isAudio(source.mimeType)) return { metadata: { pages: null }, thumbnail: null, reduced: null };
  const tempPath = await downloadToTempFile(blobStorage, source.storageKey);
  try {
    return image ? await readImageFacts(tempPath, keys, blobStorage) : await readAudioFacts(tempPath);
  } catch (err) {
    if (err instanceof MediaToolError) return UNREADABLE_FACTS;
    throw err;
  } finally {
    await removeTempFile(tempPath);
  }
}

/**
 * Writes the facts and removes the stored images the write does not keep. The images were written to storage before
 * the write, which is one transaction, and a `blobs` row is the only thing that makes a stored file referenced
 * (`2026-09-28-blob-bytes-deleted-best-effort-after-the-commit`): when the transaction fails before the facts were
 * written, both images are removed; when it fails at `COMMIT`, whether the rows committed is unknown, and removing bytes
 * a committed row references would be worse than leaving an unreferenced file, so only the images no row of this write
 * names are removed.
 */
async function recordFacts(
  pool: Pool,
  attachmentId: string,
  facts: AttachmentFacts,
  blobStorage: BlobStorageWriter,
): Promise<RecordedInboxAttachmentMetadata> {
  const progress: { recorded: RecordedInboxAttachmentMetadata | null } = { recorded: null };
  try {
    return await withTransaction(pool, async (client) => {
      const recorded = await recordInboxAttachmentMetadata(client, {
        attachmentId,
        metadata: facts.metadata,
        thumbnail: facts.thumbnail && toDerivedImage(facts.thumbnail),
        reduced: facts.reduced && toDerivedImage(facts.reduced),
      });
      if (recorded.recorded && facts.metadata.audioKind === "voiceNote") {
        // The item's id is read after the write, in the same transaction, so the job exists exactly when the metadata
        // does. A failure here rolls the write back, and `progress` is still unset, so the finally removes the images.
        const attachment = await getInboxAttachment(client, attachmentId);
        // The row was written a moment ago in this transaction; only a broken invariant can lack it.
        if (!attachment) throw new Error(`Inbox attachment ${attachmentId} is gone after its metadata was recorded`);
        await enqueueInboxVoiceNoteTranscribe(client, attachment.inboxItemId);
      }
      progress.recorded = recorded;
      return recorded;
    });
  } finally {
    const stored = [facts.thumbnail, facts.reduced].flatMap((image) => (image === null ? [] : [image.storageKey]));
    for (const key of progress.recorded?.unusedStorageKeys ?? stored) await discardStoredImage(blobStorage, key);
  }
}

/**
 * The handler of `inboxAttachmentMetadata` (issue gh-1965): computes the facts of one Inbox attachment after it is
 * attached and records them once, with `ffprobe` and `ffmpeg` called only through `mediaNormalization.ts`.
 *
 * - A photo (JPEG, PNG) gets its width and height, a 128 px preview and a reduced copy of at most 1568 px, both as
 *   JPEG blobs (never enlarged); audio (M4A, MP3) gets its duration, `audioKind` (`audioKindForDuration`) and, if the
 *   file's `creation_time` tag is usable, `recordedAt`. The probe is authoritative: nothing the client sent is read.
 * - A file that cannot be read gets `metadata.error` and no images; the capture is long committed, so nothing fails.
 *   A picture of more than `MAX_IMAGE_PIXELS` is one: the tools refuse to decode it (`-max_pixels`).
 * - The slow work (the download, `ffprobe`, `ffmpeg`) runs outside any transaction. One transaction then writes the
 *   facts and announces the update of the source Inbox item to its heartbeats (`recordInboxAttachmentMetadata`).
 *   For a voice note (`audioKind` `voiceNote`) the same transaction queues the transcription of the item's voice notes
 *   (`enqueueInboxVoiceNoteTranscribe`, issue gh-1980), so that job exists exactly when the metadata does.
 * - An attachment that is gone, one of another tenant (the job runs in the tenant of its envelope, where it is as
 *   good as gone) and one that already has `metadata` are skipped without reading the file, so a rerun changes nothing.
 *   A run that loses a race to another run records nothing and removes the images it wrote.
 *
 * Nothing about the file is logged: not its name, bytes or the tools' messages.
 */
export function createInboxAttachmentMetadataTask(pool: Pool, blobStorage: BlobStorageWriter) {
  return async (payload: unknown): Promise<void> => {
    const { attachmentId } = inboxAttachmentMetadataPayloadSchema.parse(payload);
    const plan = await withTransaction(pool, async (client) => {
      const source = await readInboxAttachmentForMetadata(client, attachmentId);
      if (!source) return null;
      const base = await tenantBlobStorageKey(client, `inbox-attachments/${randomUUID()}`);
      return { source, keys: { thumbnail: `${base}-preview.jpg`, reduced: `${base}-reduced.jpg` } };
    });
    if (!plan) {
      logger.info({ attachmentId, outcome: "skipped" }, "Inbox attachment metadata has no attachment to read");
      return;
    }
    if (plan.source.metadataRecorded) {
      logger.info({ attachmentId, outcome: "skipped" }, "Inbox attachment metadata is already recorded");
      return;
    }
    const facts = await readFacts(plan.source, plan.keys, blobStorage);
    const { recorded } = await recordFacts(pool, attachmentId, facts, blobStorage);
    logger.info(
      { attachmentId, outcome: recorded ? "recorded" : "skipped", unreadable: facts.metadata.error !== undefined },
      "Inbox attachment metadata finished",
    );
  };
}
