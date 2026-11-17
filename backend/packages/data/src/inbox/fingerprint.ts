import { createHash } from "node:crypto";
import { canonicalizeJson, compareByCodePoint } from "@semprec/shared";

/**
 * Processing proposals' `fingerprint` property (issue #223) holds one of two shapes
 * depending on `kind`: an Inbox source (`kind: 'inbox'`) stores the fingerprint string this
 * module computes; a Transcript source (`kind: 'transcript'`, out of this issue's scope) keeps
 * the pre-existing `{text,startsAt,endsAt}` object shape instead — the same property, two shapes,
 * distinguished by `kind`.
 *
 * The Inbox fingerprint is versioned (issue #1606): the tick writes version 2, a value starting with
 * `v2:` (`computeInboxFingerprintV2`).
 */

const V2_PREFIX = "v2:";

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
 * Whether a stored Inbox fingerprint still describes the item (issue #1606): it equals the version 2
 * fingerprint of `current`. Any other stored value is stale.
 */
export function isFingerprintCurrent(stored: unknown, current: InboxFingerprintV2Input): boolean {
  return typeof stored === "string" && stored.startsWith(V2_PREFIX) && stored === computeInboxFingerprintV2(current);
}
