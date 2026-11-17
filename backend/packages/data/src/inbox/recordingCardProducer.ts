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

// What the tick proposes for an Inbox item holding a long recording (an audio attachment with `audioKind`
// `recording`). `buildRecordingCard` only reads; the tick stores the draft.

const NAME_FROM_TEXT_MAX_LENGTH = 200;

export interface RecordingCardDraft {
  envelope: ProposalEnvelope;
  context: RecordingCardContext;
}

function isAudioAttachment(attachment: InboxAttachmentRow): boolean {
  return attachment.mimeType.startsWith("audio/");
}

/** The first non-blank line of the item's text without a leading Markdown marker, cut to the limit; `null` if none. */
function nameFromText(text: unknown): string | null {
  if (typeof text !== "string") return null;
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.replace(/^\s*(?:(?:#{1,6}|[-*+]|>)\s+)*/, "").trim();
    if (stripped.length > 0) return Array.from(stripped).slice(0, NAME_FROM_TEXT_MAX_LENGTH).join("");
  }
  return null;
}

/** "Recording D. M. HH:mm" for the recording's wall-clock time, or "Recording" when unknown, from the Inbox catalogs. */
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
 * Builds the recording card for `attachmentId` (chosen by `routeInboxAttachments`, so its metadata exists), in the
 * caller's tenant scope. Duration and recording time are the metadata's, with no fallback to upload or current time.
 * With a recording time, `candidates` are that local day's Events; without, none. The name comes from the item's
 * text, else the localized default. No language, speakers, Event or project is proposed.
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
