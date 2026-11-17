// What the agent is told about an Emails item with a `mail_drafts` row that a person attached to a Semp message: the
// draft's fields and the instruction to change it with `mail.draft.update`. Read-only.
import type { PoolClient } from "pg";
import type { ItemRow } from "../types.js";
import { getMailDraft, type MailDraftMode, type MailDraftRecipient } from "./mailDraftsStore.js";

export const MAX_DRAFT_REF_BODY_CHARS = 5_000;
/**
 * The agents process renders a ref as `<kind>: <label>\n<details>` and silently cuts a section over 8000 UTF-16 units,
 * so the serialized details stay below that by the longest prefix (`item: `, a 500-unit label, the line break).
 */
export const MAX_DRAFT_REF_DETAILS_CHARS = 7_200;
/** Shared by `to`, `cc` and `bcc`; recipients over it are counted in `recipientsOmitted`. */
export const MAX_DRAFT_REF_RECIPIENT_CHARS = 2_000;

const CUT_SECTION_SENTENCE =
  "If this reference ends with the line [truncated], it was cut and the body may be cut too, so do not rewrite it from the cut text.";

export interface MailDraftRefDetails {
  instruction: string;
  /** The keys that decide whether the body may be rewritten come before the recipient lists, the largest part. */
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
    recipientsOmitted: number;
  };
}

function textProperty(item: ItemRow, key: string): string {
  const value = item.properties[key];
  return typeof value === "string" ? value : "";
}

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

/** Cuts by code points (never a surrogate half) to `MAX_DRAFT_REF_BODY_CHARS` and to `room` units of its JSON form. */
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
 * Null for a trashed item or one without a `mail_drafts` row; the caller expands those as any Emails item. A sent
 * draft is reported as no longer changeable so the agent does not try.
 *
 * A body that does not fit is cut and flagged, and the instruction says so, because a rewrite replaces the whole
 * body. A turn with many refs can still cut the section; the instruction covers a trailing `[truncated]` too.
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
  // Measured with the longer instruction, so the budget holds for either outcome.
  const shell = JSON.stringify(build("", true)).length;
  const { text, cut } = cutBody(textProperty(item, "body"), Math.max(0, MAX_DRAFT_REF_DETAILS_CHARS - shell));
  return build(text, cut);
}
