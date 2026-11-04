import { loadModuleCatalogs, resolveCatalogLabel } from "@semprec/module-registry";
import { z } from "zod";
import type { InboxTypeSummary } from "./inboxTypesStore.js";
const INBOX_TYPE_TARGET_DATABASES = [
  "areas",
  "projects",
  "tasks",
  "people",
  "files",
  "events",
  "healthRecords",
  "companies",
] as const;

export const RECOGNITION_CONFIDENCE_THRESHOLD = 0.7;
export const RECOGNITION_TARGETS = [...INBOX_TYPE_TARGET_DATABASES, "mcpServers"] as const;
export type RecognitionType = InboxTypeSummary;
export const recognitionCandidateSchema = z.union([
  z.object({ typeId: z.string(), confidence: z.number().min(0).max(1) }),
  z.object({ targetDatabaseKey: z.enum(RECOGNITION_TARGETS), confidence: z.number().min(0).max(1) }),
]);
export type RecognitionCandidate = z.infer<typeof recognitionCandidateSchema>;

export function validRecognitionTypes(types: RecognitionType[]): RecognitionType[] {
  return types.filter((type) =>
    type.processingMethod === "pageContent"
      ? type.targetDatabaseKey === null
      : type.processingMethod === "database" &&
        INBOX_TYPE_TARGET_DATABASES.some((key) => key === type.targetDatabaseKey),
  );
}
/** Invalid candidates are dropped individually, not allowed to invalidate another candidate. */
export function filterRecognitionCandidates(raw: unknown, types: RecognitionType[]): RecognitionCandidate[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set(validRecognitionTypes(types).map((type) => type.id));
  return raw
    .flatMap((value: unknown) => {
      const parsed = recognitionCandidateSchema.safeParse(value);
      return parsed.success && (!("typeId" in parsed.data) || ids.has(parsed.data.typeId)) ? [parsed.data] : [];
    })
    .sort((a, b) => b.confidence - a.confidence);
}
export function clarificationTypes(candidates: RecognitionCandidate[], catalog: RecognitionType[]) {
  const valid = validRecognitionTypes(catalog);
  const ranked = candidates.flatMap((candidate) =>
    "typeId" in candidate ? valid.filter((type) => type.id === candidate.typeId) : [],
  );
  const selected = [...new Map(ranked.map((type) => [type.id, type])).values()].slice(0, 4);
  for (const type of valid) {
    if (selected.length >= 2) break;
    if (!selected.some((existing) => existing.id === type.id)) selected.push(type);
  }
  return selected.map((type) => ({ typeId: type.id, label: type.label, targetDatabaseKey: type.targetDatabaseKey }));
}
export async function recognitionClarificationReason(
  locale: "cs" | "en",
  count: number,
  reason?: string,
): Promise<string> {
  const catalogs = await loadModuleCatalogs(import.meta.url);
  const fallback = resolveCatalogLabel(undefined, catalogs[locale], catalogs.en, "inbox.recognition.chooseType");
  const shortage = resolveCatalogLabel(undefined, catalogs[locale], catalogs.en, "inbox.recognition.typeShortage");
  return (count < 2 ? `${shortage} ${reason?.trim() || fallback}` : reason?.trim() || fallback).slice(0, 500);
}

export async function recognitionChangedReason(locale: "cs" | "en"): Promise<string> {
  const catalogs = await loadModuleCatalogs(import.meta.url);
  return resolveCatalogLabel(undefined, catalogs[locale], catalogs.en, "inbox.recognition.changed");
}

export async function recognitionClarificationPatch(
  locale: "cs" | "en",
  choices: ReturnType<typeof clarificationTypes>,
  changed: boolean,
  reason?: string,
) {
  return {
    recognizedTypeId: null,
    typeCandidates: choices,
    reason: await recognitionClarificationReason(
      locale,
      choices.length,
      changed ? await recognitionChangedReason(locale) : reason,
    ),
  };
}

export const RECOGNITION_CARD_KEYS = ["recognizedTypeId", "typeCandidates", "reason"] as const;
