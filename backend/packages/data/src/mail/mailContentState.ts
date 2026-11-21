import type { MailArrival } from "./mailArrival.js";

export const MAIL_CONTENT_STATES = ["full", "index"] as const;
/** `full`: body and attachment bytes stored; `index`: envelope, preview and attachment metadata only. */
export type MailContentState = (typeof MAIL_CONTENT_STATES)[number];

/** How far before the account's `connected_at` a message's Date may lie and still have its content stored. */
export const MAIL_FULL_CONTENT_WINDOW_DAYS = 90;

const FULL_CONTENT_WINDOW_MS = MAIL_FULL_CONTENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Live mail is always stored in full. History is stored in full when its Date lies within the window before
 * `connectedAt`, and indexed otherwise; history without a Date is indexed.
 */
export function mailContentStateOf(input: { arrival: MailArrival; date?: Date; connectedAt: Date }): MailContentState {
  if (input.arrival === "live") return "full";
  if (input.date && input.date.getTime() >= input.connectedAt.getTime() - FULL_CONTENT_WINDOW_MS) return "full";
  return "index";
}

/**
 * What a reader is told of a message's body: `full` is stored with the message, `cached` was fetched from the provider
 * on demand within the last `MAIL_CONTENT_CACHE_DAYS`, `remote` is with the provider only (an `index` message whose
 * body was not fetched, or whose fetched copy expired).
 */
export const MAIL_MESSAGE_CONTENT_STATES = ["full", "cached", "remote"] as const;
export type MailMessageContentState = (typeof MAIL_MESSAGE_CONTENT_STATES)[number];
