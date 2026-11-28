import { z } from "zod";
import { loadModuleCatalogs, resolveCatalogLabel, type ModuleCatalogs } from "@alldots/module-registry";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import type { TranscriptSpeaker } from "./transcriptionSpeakerEdges.js";

/** The stored `computed.meetingNotes`, validated where it is read: it is a JSONB value. */
const storedMeetingNotesSchema = z.object({
  title: z.string(),
  summary: z.string(),
  shortSummary: z.string(),
  decisions: z.array(z.string()),
  actionItems: z.array(
    z.object({
      text: z.string(),
      ownerSpeaker: z.string().nullable(),
      due: z.string().nullable(),
      startsAt: z.number().nullable(),
    }),
  ),
});
export type StoredMeetingNotes = z.infer<typeof storedMeetingNotesSchema>;

/** `null` when the key is absent; a malformed value throws. */
export function parseStoredMeetingNotes(value: unknown): StoredMeetingNotes | null {
  if (value === undefined) return null;
  return storedMeetingNotesSchema.parse(value);
}

let catalogsPromise: Promise<ModuleCatalogs> | undefined;
function loadCatalogs(): Promise<ModuleCatalogs> {
  catalogsPromise ??= loadModuleCatalogs(import.meta.url).catch((error: unknown) => {
    catalogsPromise = undefined;
    throw error;
  });
  return catalogsPromise;
}

const SPEAKER_TOKEN = /\{(SPEAKER_\d+)\}/g;

/**
 * Renders the stored notes at read time against the transcript's speakers, so mapping a speaker
 * changes the text on the next read with no model call. Only a `speakers` edge to a person maps a
 * speaker; an unconfirmed suggestion card maps nothing. `{SPEAKER_NN}` becomes the person's first
 * name, "Speaker N" when unmapped or nameless, or the generic word for a token naming no speaker of
 * the transcript. Action item `id` is its position in the stored array.
 */
export async function renderMeetingNotes(notes: StoredMeetingNotes, speakers: TranscriptSpeaker[], locale: string) {
  const catalogs = await loadCatalogs();
  const label = (key: string) => resolveCatalogLabel(null, catalogs[toManifestLocale(locale)], catalogs.en, key);
  const unmapped = (ordinal: number) => label("transcript.speaker.unmappedLabel").replace("{ordinal}", String(ordinal));
  const generic = label("transcript.speaker.genericLabel");
  const byKey = new Map(speakers.map((speaker) => [speaker.speaker, speaker]));
  const fullName = (speaker: TranscriptSpeaker) => {
    const name = speaker.person?.name?.trim();
    return name ? name : null;
  };
  const textName = (key: string) => {
    const speaker = byKey.get(key);
    if (!speaker) return generic;
    const name = fullName(speaker);
    return name ? (name.split(/\s+/)[0] ?? name) : unmapped(speaker.ordinal);
  };
  const render = (text: string) => text.replace(SPEAKER_TOKEN, (_token, key: string) => textName(key));
  const ownerLabel = (key: string | null) => {
    if (key === null) return null;
    const speaker = byKey.get(key);
    if (!speaker) return generic;
    return fullName(speaker) ?? unmapped(speaker.ordinal);
  };
  return {
    title: render(notes.title),
    summary: render(notes.summary),
    shortSummary: render(notes.shortSummary),
    decisions: notes.decisions.map(render),
    actionItems: notes.actionItems.map((item, index) => ({
      id: index,
      text: render(item.text),
      ownerSpeaker: item.ownerSpeaker,
      ownerLabel: ownerLabel(item.ownerSpeaker),
      due: item.due,
      startsAt: item.startsAt,
    })),
  };
}
