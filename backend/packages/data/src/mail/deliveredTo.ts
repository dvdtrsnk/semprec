import { normalizeEmailAddress } from "./personEmailIndexStore.js";
import type { MailEnvelopeAddress } from "./mailMessageMetaStore.js";

export interface DeliveredToCandidates {
  /** Every `Delivered-To` occurrence, top to bottom; index 0 is the highest. */
  deliveredToHeaders: string[];
  xOriginalTo?: string | null;
  envelopeTo?: string | null;
}

function extractAddress(raw: string): string {
  const match = raw.match(/<([^<>]+)>/);
  return (match?.[1] ?? raw).trim();
}

export interface ResolveDeliveredToAddressInput {
  candidates: DeliveredToCandidates;
  structuredTo: MailEnvelopeAddress[];
  structuredCc: MailEnvelopeAddress[];
  /** `Mailboxes.addresses` in listed order; the first entry is the primary-address fallback. */
  mailboxAliases: string[];
}

/**
 * Precedence: highest `Delivered-To`, `X-Original-To`, `Envelope-To`, the first mailbox alias
 * in structured To/Cc, then the primary address. Resolved once at ingest and persisted on
 * `mail_message_meta`.
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
