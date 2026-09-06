import { createHash } from "node:crypto";

/**
 * Processing proposals' `fingerprint` property (issue #223) holds one of two shapes
 * depending on `kind`: an Inbox source (`kind: 'inbox'`) stores the plain SHA-256 hex
 * string this module computes; a Transcript source (`kind: 'transcript'`, out of this
 * issue's scope) keeps the pre-existing `{text,startsAt,endsAt}` object shape instead —
 * the same property, two shapes, distinguished by `kind`.
 */
export type TranscriptFingerprint = { text: string; startsAt: string; endsAt: string };

/**
 * SHA-256 fingerprint of an Inbox source (issue #223's create/revise/skip gate): the
 * canonical type emoji plus the item's text. Anything else about the item (date, time,
 * journalDay) never changes this value, so editing only those fields makes no AI call.
 */
export function computeInboxFingerprint(emoji: string, text: string): string {
  return createHash("sha256").update(JSON.stringify({ emoji, text })).digest("hex");
}
