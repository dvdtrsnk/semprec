import type { GmailHistoryResult, GmailMailClient } from "../mail/gmailReconcile.js";

/**
 * `listMessageIds` of a Gmail account whose messages all lie inside the full-content window: the `after:` listing
 * phase lists `ids` on one page, the `before:` phase lists none.
 */
export function recentGmailListing(ids: readonly string[]): GmailMailClient["listMessageIds"] {
  return async (query) => ({ ids: query.startsWith("after:") ? [...ids] : [], nextPageToken: null });
}

/**
 * A `history.list` answer up to `newHistoryId`: one record of that id with `changed` and `removed` messages, or no
 * record when both are empty.
 */
export function gmailHistory(
  newHistoryId: string,
  changed: readonly string[] = [],
  removed: readonly string[] = [],
): GmailHistoryResult {
  const records =
    changed.length > 0 || removed.length > 0
      ? [{ id: newHistoryId, changedMessageIds: [...changed], removedMessageIds: [...removed] }]
      : [];
  return { invalidated: false, newHistoryId, records };
}
