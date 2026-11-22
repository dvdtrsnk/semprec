export const MAIL_ARRIVALS = ["live", "backfill"] as const;
/** `live`: new mail after the account connected; `backfill`: history imported by an initial sync or a full resync. */
export type MailArrival = (typeof MAIL_ARRIVALS)[number];

/** How much older than the account's `connected_at` a message reported as new may be and still count as live. */
export const MAIL_LIVE_ARRIVAL_DATE_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * A message is live only when the provider reports it as new since the account's baseline and its Date is not older
 * than `connectedAt` less the grace, which keeps old mail another client moves in from counting as new. A message
 * without a Date is judged by the provider alone.
 */
export function mailArrivalOf(input: { reportedNew: boolean; date?: Date; connectedAt: Date }): MailArrival {
  if (!input.reportedNew) return "backfill";
  if (input.date && input.date.getTime() < input.connectedAt.getTime() - MAIL_LIVE_ARRIVAL_DATE_GRACE_MS)
    return "backfill";
  return "live";
}
