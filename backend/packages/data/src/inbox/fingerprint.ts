import { createHash } from "node:crypto";
import { canonicalizeJson, compareByCodePoint } from "@semprec/shared";

/**
 * Processing proposals' `fingerprint` property (issue #223) holds one of two shapes
 * depending on `kind`: an Inbox source (`kind: 'inbox'`) stores the fingerprint string this
 * module computes; a Transcript source (`kind: 'transcript'`, out of this issue's scope) keeps
 * the pre-existing `{text,startsAt,endsAt}` object shape instead — the same property, two shapes,
 * distinguished by `kind`.
 *
 * The Inbox fingerprint is versioned (issue #1606). A value starting with `v2:` is version 2
 * (`computeInboxFingerprintV2`); any other string is a version 1 value written before that issue
 * (`computeInboxFingerprint`). `isFingerprintCurrent` compares a stored value of either version.
 */

const V2_PREFIX = "v2:";

/**
 * Version 1 fingerprint of an Inbox source (issue #223): the canonical type emoji plus the item's
 * text. The tick writes version 2 only; this stays so that a version 1 value already stored can be
 * compared (see `isFingerprintCurrent`).
 */
export function computeInboxFingerprint(emoji: string, text: string): string {
  return createHash("sha256").update(JSON.stringify({ emoji, text })).digest("hex");
}

/** Everything version 2 of the Inbox fingerprint covers (issue #1606). */
export interface InboxFingerprintV2Input {
  /** The Inbox item type's id, so choosing another type that shares its emoji changes the value. */
  typeId: string;
  text: string;
  /** The item's capture date and time, as stored (for example `2026-08-28` and `09:00`). */
  date: string;
  time: string;
  /** The `blobs.content_hash` of each attachment reference of the item, in any order. */
  attachmentHashes: readonly string[];
  /** The transcript text of the item's audio attachments, `""` while Inbox audio is not transcribed. */
  transcribedText: string;
}

/**
 * Version 2 fingerprint of an Inbox source (issue #1606): the SHA-256 of the canonical JSON of
 * `{ v: 2, typeId, text, date, time, attachmentHashes, transcribedText }`, with `attachmentHashes`
 * sorted, stored as `v2:<hex>`. The order of the input's keys and of its attachment hashes has no
 * effect on the value.
 */
export function computeInboxFingerprintV2(input: InboxFingerprintV2Input): string {
  const canonical = canonicalizeJson({
    v: 2,
    typeId: input.typeId,
    text: input.text,
    date: input.date,
    time: input.time,
    attachmentHashes: [...input.attachmentHashes].sort(compareByCodePoint),
    transcribedText: input.transcribedText,
  });
  return `${V2_PREFIX}${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * Whether a stored Inbox fingerprint still describes the item (issue #1606). A version 2 value is
 * compared with the version 2 fingerprint of `current.v2Input`. Any other stored value is version 1
 * and is compared with the version 1 fingerprint of the current emoji and text only, so a card written
 * before this version is recomputed when its emoji or text changed, and not when only its date, time or
 * attachments changed.
 */
export function isFingerprintCurrent(
  stored: unknown,
  current: { v2Input: InboxFingerprintV2Input; legacyEmoji: string; legacyText: string },
): boolean {
  if (typeof stored === "string" && stored.startsWith(V2_PREFIX)) {
    return stored === computeInboxFingerprintV2(current.v2Input);
  }
  return stored === computeInboxFingerprint(current.legacyEmoji, current.legacyText);
}
