import { normalizeEmailAddress } from "./personEmailIndexStore.js";
import type { MailEnvelopeAddress } from "./mailMessageMetaStore.js";

export interface DeliveredToCandidates {
  /** Every `Delivered-To` occurrence, in the order they appear in the raw header block (top to bottom) — index 0 is the "highest" occurrence the precedence rule below starts from. */
  deliveredToHeaders: string[];
  xOriginalTo?: string | null;
  envelopeTo?: string | null;
}

/** A raw header value can be `"Name <addr>"` or a bare address — this extracts just the address. */
function extractAddress(raw: string): string {
  const match = raw.match(/<([^<>]+)>/);
  return (match?.[1] ?? raw).trim();
}

export interface ResolveDeliveredToAddressInput {
  candidates: DeliveredToCandidates;
  structuredTo: MailEnvelopeAddress[];
  structuredCc: MailEnvelopeAddress[];
  /** This mailbox's registered addresses (`Mailboxes.addresses`), in listed order — the first entry doubles as the mailbox's "primary address" fallback, since no dedicated field exists (see seedEmailModule.ts). */
  mailboxAliases: string[];
}

/**
 * Resolves `deliveredToAddress` once, at ingest, using the issue's exact precedence: highest
 * `Delivered-To` occurrence, `X-Original-To`, `Envelope-To`, the first registered mailbox
 * alias matching structured To/Cc, then the mailbox's primary address. mail/ingest.ts persists
 * the result on `mail_message_meta`; nothing downstream recomputes it.
 */
export function resolveDeliveredToAddress(input: ResolveDeliveredToAddressInput): string | undefined {
  const { candidates, structuredTo, structuredCc, mailboxAliases } = input;

  const [firstDeliveredTo] = candidates.deliveredToHeaders;
  if (firstDeliveredTo !== undefined) {
    return normalizeEmailAddress(extractAddress(firstDeliveredTo));
  }
  if (candidates.xOriginalTo) {
    return normalizeEmailAddress(extractAddress(candidates.xOriginalTo));
  }
  if (candidates.envelopeTo) {
    return normalizeEmailAddress(extractAddress(candidates.envelopeTo));
  }

  const structuredAddresses = new Set([...structuredTo, ...structuredCc].map((a) => normalizeEmailAddress(a.address)));
  for (const alias of mailboxAliases) {
    const normalizedAlias = normalizeEmailAddress(alias);
    if (structuredAddresses.has(normalizedAlias)) return normalizedAlias;
  }

  const [firstAlias] = mailboxAliases;
  return firstAlias !== undefined ? normalizeEmailAddress(firstAlias) : undefined;
}
