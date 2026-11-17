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
const REDUCED_LONG_SIDE_PIXELS = 1568;

interface AttachmentFacts {
  metadata: InboxAttachmentMetadata;
  thumbnail: StoredMediaResult | null;
  reduced: StoredMediaResult | null;
}

/** Only the failure's code, nothing of the file. */
const UNREADABLE_FACTS: AttachmentFacts = {
  metadata: { error: INBOX_ATTACHMENT_UNREADABLE, pages: null },
  thumbnail: null,
  reduced: null,
};

/** Fresh per run, so two runs never share a key. */
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
 * Only a `MediaToolError` is a property of the file (`UNREADABLE_FACTS`); anything else propagates so
 * the job is retried. A PDF or office document is not opened.
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
 * Removes the stored images the write does not keep. On a failure at `COMMIT` it is unknown whether
 * the rows committed, so only images no row of this write names are removed; an unreferenced file
 * is better than a row pointing at deleted bytes.
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
        // Same transaction, so the job exists exactly when the metadata does.
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
 * Computes an Inbox attachment's facts once. The probe is authoritative: nothing the client sent is
 * read. An unreadable file gets `metadata.error` and no images. Slow work runs outside any
 * transaction; one transaction then writes the facts and, for a voice note, queues its
 * transcription. Gone, foreign-tenant or already-recorded attachments are skipped; a run losing a
 * race removes its images. Nothing about the file is logged.
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
