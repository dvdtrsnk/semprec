import type { ImapFetchedMessage, ImapFetchedRange, ImapMailClient } from "../mail/imapReconcile.js";
import type { FetchedMessage } from "../mail/providerTypes.js";

/**
 * `message` as a fake IMAP client's light fetch returns it: its attachments as metadata (part ids from 2, sizes 0),
 * its text part (else HTML part) as the snippet part, and its bodies and attachments as the content `fetchContent`
 * gives, after calling `onFetchContent`.
 */
export function fakeFetchedMessage(
  uid: number,
  message: FetchedMessage,
  onFetchContent?: () => void,
): ImapFetchedMessage {
  const { bodyText, bodyHtml, attachments, ...envelope } = message;
  return {
    uid,
    message: envelope,
    attachments: attachments.map(({ filename, contentType, contentId, disposition }, index) => ({
      filename,
      contentType,
      contentId,
      disposition,
      providerPart: String(index + 2),
      byteSize: 0,
    })),
    ...(bodyText !== undefined || bodyHtml !== undefined
      ? { snippetPart: { section: "1", html: bodyText === undefined } }
      : {}),
    fetchContent: async () => {
      onFetchContent?.();
      return { bodyText, bodyHtml, attachments };
    },
  };
}

/**
 * A fake client's answer to `fetchMessagesSince` or `fetchMessagesBefore`: the first `limit` of `messages`, in their
 * order, as a range whose search found exactly them and `more` when `messages` holds more.
 */
export function fakeImapRange(
  messages: readonly ImapFetchedMessage[],
  limit: number = Number.MAX_SAFE_INTEGER,
): ImapFetchedRange {
  const taken = messages.slice(0, limit);
  return { uids: taken.map((message) => message.uid), messages: taken, more: messages.length > taken.length };
}

/** A fake `fetchMessagesSince` answering what `list` gives for the path and cursor, cut at the limit as a range. */
export function fakeImapSince(
  list: (path: string, sinceUid: number) => Promise<readonly ImapFetchedMessage[]> | readonly ImapFetchedMessage[],
): ImapMailClient["fetchMessagesSince"] {
  return async (path, sinceUid, limit) => fakeImapRange(await list(path, sinceUid), limit);
}

/**
 * A `fetchMessagesBefore` over the messages `client.fetchMessagesSince` reports from UID 1 (looked up at each call):
 * those below `beforeUid`, highest UIDs first.
 */
export function backfillOfFetchedSince(
  client: Pick<ImapMailClient, "fetchMessagesSince">,
): ImapMailClient["fetchMessagesBefore"] {
  return async (path, beforeUid, limit) =>
    fakeImapRange(
      (await client.fetchMessagesSince(path, 1, Number.MAX_SAFE_INTEGER)).messages
        .filter((message) => message.uid < beforeUid)
        .sort((a, b) => b.uid - a.uid),
      limit,
    );
}
