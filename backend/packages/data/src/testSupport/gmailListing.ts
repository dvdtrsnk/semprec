import type { GmailMailClient } from "../mail/gmailReconcile.js";

/**
 * `listMessageIds` of a Gmail account whose messages all lie inside the full-content window: the `after:` listing
 * phase lists `ids` on one page, the `before:` phase lists none.
 */
export function recentGmailListing(ids: readonly string[]): GmailMailClient["listMessageIds"] {
  return async (query) => ({ ids: query.startsWith("after:") ? [...ids] : [], nextPageToken: null });
}
