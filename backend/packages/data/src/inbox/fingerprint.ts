import { createHash } from "node:crypto";
import { canonicalizeJson, compareByCodePoint } from "@semprec/shared";

/**
 * Processing proposals' `fingerprint` has two shapes by `kind`: Inbox sources store the `v2:` string computed here;
 * Transcript sources store a `{text,startsAt,endsAt}` object.
 */

const V2_PREFIX = "v2:";

export interface InboxFingerprintV2Input {
  /** So choosing another type with the same emoji changes the value. */
  typeId: string;
  text: string;
  date: string;
  time: string;
  /** Order does not matter. */
  attachmentHashes: readonly string[];
  /** `""` while Inbox audio is not transcribed. */
  transcribedText: string;
}

/** SHA-256 of canonical JSON, `attachmentHashes` sorted, so key and hash order have no effect. */
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

export function isFingerprintCurrent(stored: unknown, current: InboxFingerprintV2Input): boolean {
  return typeof stored === "string" && stored.startsWith(V2_PREFIX) && stored === computeInboxFingerprintV2(current);
}
