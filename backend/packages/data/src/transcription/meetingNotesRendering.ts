import { z } from "zod";
import { loadModuleCatalogs, resolveCatalogLabel, type ModuleCatalogs } from "@semprec/module-registry";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import type { TranscriptSpeaker } from "./transcriptionSpeakerEdges.js";

/** The stored `computed.meetingNotes` (issue #1695), validated where it is read: it is a JSONB value. */
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

/** The notes in `computed.meetingNotes`, or `null` when the key is absent; a malformed value throws. */
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
 * The meeting notes as a reader shows them (issue #1695), rendered at read time from the stored
 * notes and the transcript's speakers, so mapping a speaker changes the text on the next read with
 * no model call. A speaker counts as mapped only through a `speakers` edge to a person
 * (`listTranscriptSpeakers`); an unconfirmed suggestion card maps nothing. In running text a
 * `{SPEAKER_NN}` token becomes the mapped person's first name (the first word of their name),
 * "Speaker N" (`transcript.speaker.unmappedLabel`, N the speaker's ordinal) for an unmapped speaker
 * or a person without a name, and the generic word (`transcript.speaker.genericLabel`) for a token
 * that names no speaker of the transcript. Each action item gains `ownerLabel` (the owner's full
 * name, "Speaker N", or `null` without an owner) and `id`, its position in the stored array.
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
