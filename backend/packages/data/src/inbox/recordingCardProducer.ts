import type { PoolClient } from "pg";
import { loadModuleCatalogs, resolveCatalogLabel } from "@semprec/module-registry";
import { getTenantUserLocale } from "../auth/usersStore.js";
import { instantToWallClock, type WallClock } from "../calendarTime.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import { listRecordingDayCandidates } from "../transcription/recordingCardCandidates.js";
import type { ItemRow } from "../types.js";
import { getInboxAttachment, type InboxAttachmentRow } from "./inboxAttachmentsStore.js";
import { readProposalTimezone } from "./proposalComputedUpdates.js";
import type { ProposalEnvelope } from "./proposalEnvelope.js";
import { RECORDING_ENTITY_KIND, type RecordingCardContext } from "./recordingCardEnvelope.js";

// The producer side of the recording card (issue gh-1978): what the Inbox tick proposes for an Inbox item that holds a
// long recording (an audio attachment whose `audioKind` is `recording`, chosen by `routeInboxAttachments`).
// `buildRecordingCard` only reads; the tick stores the draft (`writeTickResult`) and the confirm that starts the
// transcription is `recordingCardConfirm.ts`.

/** The longest name proposed from the text of an Inbox item, in characters. */
const NAME_FROM_TEXT_MAX_LENGTH = 200;

/** What the tick stores for a recording: the envelope that proposes the transcription and the `context` of the card. */
export interface RecordingCardDraft {
  envelope: ProposalEnvelope;
  context: RecordingCardContext;
}

/** Whether `attachment` is an audio file. */
function isAudioAttachment(attachment: InboxAttachmentRow): boolean {
  return attachment.mimeType.startsWith("audio/");
}

/**
 * The name the item's own text gives the recording: its first non-blank line, without a leading Markdown heading,
 * list or quote marker, cut to `NAME_FROM_TEXT_MAX_LENGTH` characters; `null` when the item has no text.
 */
function nameFromText(text: unknown): string | null {
  if (typeof text !== "string") return null;
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.replace(/^\s*(?:(?:#{1,6}|[-*+]|>)\s+)*/, "").trim();
    if (stripped.length > 0) return Array.from(stripped).slice(0, NAME_FROM_TEXT_MAX_LENGTH).join("");
  }
  return null;
}

/**
 * The localized default name of a recording whose item has no text: "Recording D. M. HH:mm" for the wall-clock time the
 * recording was made, "Recording" when that time is unknown. The labels are the ones of the Inbox catalogs
 * (`inbox.recordingCard.defaultName.dated` and `.undated`).
 */
async function defaultRecordingName(locale: string, recordedAt: WallClock | null): Promise<string> {
  const catalogs = await loadModuleCatalogs(new URL("../seed/systemDatabasesModuleManifest.js", import.meta.url).href);
  const label = (key: string) => resolveCatalogLabel(null, catalogs[toManifestLocale(locale)], catalogs.en, key);
  if (recordedAt === null) return label("inbox.recordingCard.defaultName.undated");
  const [, month, day] = recordedAt.date.split("-").map(Number);
  return label("inbox.recordingCard.defaultName.dated")
    .replace("{day}", String(day ?? 0))
    .replace("{month}", String(month ?? 0))
    .replace("{time}", recordedAt.time);
}

/**
 * Builds the recording card of `item` for its audio attachment `attachmentId`, in the caller's tenant scope. The
 * attachment is the one `routeInboxAttachments` chose, so its metadata exists; the recording's duration and time are
 * the metadata's, unchanged, and each is left out of the context when the metadata has none: there is no fallback to the
 * upload or the current time. With a recording time, `candidates` are the Events of the recording's local day
 * (`listRecordingDayCandidates`) and an item without text is named "Recording D. M. HH:mm"; without one `candidates` is
 * empty, no day is looked up and the name is "Recording". An item with text is named from it either way
 * (`nameFromText`). The envelope proposes no language, speaker count, Event or project.
 */
export async function buildRecordingCard(
  client: PoolClient,
  item: ItemRow,
  attachmentId: string,
): Promise<RecordingCardDraft> {
  const audio = await getInboxAttachment(client, attachmentId);
  if (!audio || audio.inboxItemId !== item.id || !isAudioAttachment(audio)) {
    throw new Error(`Attachment ${attachmentId} is not an audio attachment of Inbox item ${item.id}`);
  }
  const metadata = audio.metadata;
  const recordedAtMs = metadata?.recordedAt === undefined ? Number.NaN : Date.parse(metadata.recordedAt);
  const recordedAt = Number.isFinite(recordedAtMs) ? metadata?.recordedAt : undefined;
  const locale = (await getTenantUserLocale(client)) ?? "cs";
  let wallClock: WallClock | null = null;
  let candidates: RecordingCardContext["candidates"] = [];
  if (recordedAt !== undefined) {
    wallClock = instantToWallClock(new Date(recordedAtMs), await readProposalTimezone(client));
    candidates = await listRecordingDayCandidates(client, wallClock.date);
  }
  const name = nameFromText(item.properties.text) ?? (await defaultRecordingName(locale, wallClock));
  return {
    envelope: { entityKind: RECORDING_ENTITY_KIND, target: audio.attachmentId, properties: { name } },
    context: {
      role: "recording",
      candidates,
      recording: {
        ...(metadata?.durationSeconds === undefined ? {} : { durationSeconds: metadata.durationSeconds }),
        ...(recordedAt === undefined ? {} : { recordedAt }),
        source: audio.source,
      },
    },
  };
}
