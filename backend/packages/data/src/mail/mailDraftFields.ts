// The limits and the checks that every writer of a mail draft applies to the values it takes from outside or from a
// stored message: the draft routes (`mailDraftRouteHandlers.ts`), the agent tools (`mailAgentTools.ts`) and the prefill
// of a reply (`mailDraftPrefill.ts`). A value that reaches a header of the outgoing mail may hold no line break, or its
// writer could inject a header.
import { z } from "zod";

export const MAX_ADDRESS_LENGTH = 320;
export const MAX_NAME_LENGTH = 320;
/** The longest header line RFC 5322 allows, which the subject has to fit. */
export const MAX_SUBJECT_LENGTH = 998;
export const MAX_BODY_LENGTH = 500_000;
/** The recipients of one list; a list longer than this is no person's mail. */
export const MAX_RECIPIENTS = 100;

/** One address without whitespace or a comma, the same shape the mailbox connect route accepts. */
export const ADDRESS_PATTERN = /^[^\s@,]+@[^\s@,]+$/;
/** A control character (general category Cc, line breaks included) or an unpaired surrogate (Cs). */
export const UNSTORABLE_HEADER_CHARACTER = /[\p{Cc}\p{Cs}]/u;
/** An unpaired surrogate (Cs), which `jsonb` refuses. */
const UNPAIRED_SURROGATE = /\p{Cs}/u;

/** Postgres refuses U+0000 in `text` and `jsonb`, and `jsonb` refuses an unpaired surrogate. */
const isStorableBody = (value: string): boolean => !value.includes("\u0000") && !UNPAIRED_SURROGATE.test(value);

const headerText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !UNSTORABLE_HEADER_CHARACTER.test(value));

export const draftAddress = z
  .string()
  .trim()
  .max(MAX_ADDRESS_LENGTH)
  .regex(ADDRESS_PATTERN)
  .refine((value) => !UNSTORABLE_HEADER_CHARACTER.test(value));
const recipient = z.object({ address: draftAddress, name: headerText(MAX_NAME_LENGTH).default("") }).strict();
export const draftRecipients = z.array(recipient).max(MAX_RECIPIENTS);
export const draftSubject = headerText(MAX_SUBJECT_LENGTH);
export const draftBody = z.string().max(MAX_BODY_LENGTH).refine(isStorableBody);
