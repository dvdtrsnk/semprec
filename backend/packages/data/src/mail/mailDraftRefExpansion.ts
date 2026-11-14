// Issue gh-1948: what the agent is told about an Emails item that a person attached to a Semp message and that has a
// `mail_drafts` row. `readSempRefContext` calls this for an `item` ref of the Emails database; the draft's id, subject,
// recipients and body reach the turn context together with the instruction that the draft is changed with
// `mail.draft.update` (issue gh-1927). Nothing is written.
import type { PoolClient } from "pg";
import type { ItemRow } from "../types.js";
import { getMailDraft, type MailDraftMode, type MailDraftRecipient } from "./mailDraftsStore.js";

/** The most of the draft's body that the context carries; a longer body is cut and flagged `bodyTruncated`. */
export const MAX_DRAFT_REF_BODY_CHARS = 5_000;
/**
 * The most UTF-16 units of the serialized details (`JSON.stringify`, escapes counted). The agents process renders a ref as
 * `<kind>: <label>\n<details>` and cuts a section over 8000 units without a trace in the data, so the details stay below
 * that by the longest prefix (`item: `, a label of at most 500 units and the line break).
 */
export const MAX_DRAFT_REF_DETAILS_CHARS = 7_200;
/** The most serialized units that the `to`, `cc` and `bcc` lists share; later recipients are counted in `recipientsOmitted`. */
export const MAX_DRAFT_REF_RECIPIENT_CHARS = 2_000;

/** What the instruction says about a section that the generic per-ref bound (`boundRefSections`) cut anyway. */
const CUT_SECTION_SENTENCE =
  "If this reference ends with the line [truncated], it was cut and the body may be cut too, so do not rewrite it from the cut text.";

export interface MailDraftRefDetails {
  /** What the agent has to do with the draft, or why it cannot. */
  instruction: string;
  /**
   * The keys that decide whether the body may be rewritten (`body`, `bodyTruncated`) come before the recipient lists,
   * which are the largest part that varies.
   */
  draft: {
    id: string;
    subject: string;
    mode: MailDraftMode;
    threadId: string | null;
    lastEditedBy: "user" | "agent";
    sentAt: string | null;
    body: string;
    bodyTruncated: boolean;
    from: string;
    to: MailDraftRecipient[];
    cc: MailDraftRecipient[];
    bcc: MailDraftRecipient[];
    /** How many recipients of the three lists are not listed because the lists share `MAX_DRAFT_REF_RECIPIENT_CHARS`. */
    recipientsOmitted: number;
  };
}

function textProperty(item: ItemRow, key: string): string {
  const value = item.properties[key];
  return typeof value === "string" ? value : "";
}

/** The recipients that fit the shared budget, in the order `to`, `cc`, `bcc`; the rest is only counted. */
function fitRecipients(lists: readonly MailDraftRecipient[][]): { lists: MailDraftRecipient[][]; omitted: number } {
  let used = 0;
  let omitted = 0;
  let full = false;
  const kept = lists.map((list) => {
    const keptList: MailDraftRecipient[] = [];
    for (const recipient of list) {
      const cost = JSON.stringify(recipient).length + 1;
      if (!full && used + cost <= MAX_DRAFT_REF_RECIPIENT_CHARS) {
        keptList.push(recipient);
        used += cost;
      } else {
        full = true;
        omitted += 1;
      }
    }
    return keptList;
  });
  return { lists: kept, omitted };
}

/**
 * The longest prefix of `body` by code points, never a surrogate half, that is at most `MAX_DRAFT_REF_BODY_CHARS` code
 * points and whose JSON string form (quotes and newlines count as two units) takes at most `room` units.
 */
function cutBody(body: string, room: number): { text: string; cut: boolean } {
  let units = 0;
  let count = 0;
  let end = 0;
  for (const character of body) {
    const cost = JSON.stringify(character).length - 2;
    if (count >= MAX_DRAFT_REF_BODY_CHARS || units + cost > room) return { text: body.slice(0, end), cut: true };
    units += cost;
    count += 1;
    end += character.length;
  }
  return { text: body, cut: false };
}

/**
 * The draft of `item`, an Emails item the caller has already read in the tenant of `client`: null for an item that is in
 * the Trash or has no `mail_drafts` row (a received message, a provider draft), which the caller expands as any other
 * Emails item. An open draft is answered with the instruction to change it with `mail.draft.update` and its id; a sent
 * one with the statement that it can no longer be changed, so the agent does not try.
 *
 * The serialized details stay within `MAX_DRAFT_REF_DETAILS_CHARS`, so the agents process never has to cut the section:
 * the recipients take at most `MAX_DRAFT_REF_RECIPIENT_CHARS` and the body the rest, up to `MAX_DRAFT_REF_BODY_CHARS` code
 * points. A body that does not fit is cut, `bodyTruncated` is true and the instruction says that the body is cut, because
 * a rewrite replaces the whole body. A turn with many refs can still cut the section; the instruction then tells the
 * agent to read a trailing `[truncated]` the same way.
 */
export async function readMailDraftRefDetails(client: PoolClient, item: ItemRow): Promise<MailDraftRefDetails | null> {
  if (item.deletedAt) return null;
  const draft = await getMailDraft(client, item.id);
  if (!draft) return null;
  const sent = draft.sentAt !== null;
  const instructionFor = (bodyTruncated: boolean): string =>
    sent
      ? "This draft has been sent and can no longer be changed; mail.draft.update refuses it."
      : bodyTruncated
        ? `This is an open draft. Change it with the mail.draft.update tool and draftId ${item.id}; the body below is cut, and an update replaces the whole body, so do not rewrite it from the cut text. ${CUT_SECTION_SENTENCE}`
        : `This is an open draft. Change it with the mail.draft.update tool and draftId ${item.id}; an update replaces the whole body, and the draft is not sent. ${CUT_SECTION_SENTENCE}`;
  const recipients = fitRecipients([draft.to, draft.cc, draft.bcc]);
  const [to = [], cc = [], bcc = []] = recipients.lists;
  const build = (body: string, bodyTruncated: boolean): MailDraftRefDetails => ({
    instruction: instructionFor(bodyTruncated),
    draft: {
      id: item.id,
      subject: textProperty(item, "name"),
      mode: draft.mode,
      threadId: draft.threadId,
      lastEditedBy: draft.lastEditedBy,
      sentAt: draft.sentAt === null ? null : draft.sentAt.toISOString(),
      body,
      bodyTruncated,
      from: draft.fromAddress,
      to,
      cc,
      bcc,
      recipientsOmitted: recipients.omitted,
    },
  });
  // The shell is measured with the longer (cut body) instruction, so the budget holds for either outcome.
  const shell = JSON.stringify(build("", true)).length;
  const { text, cut } = cutBody(textProperty(item, "body"), Math.max(0, MAX_DRAFT_REF_DETAILS_CHARS - shell));
  return build(text, cut);
}
