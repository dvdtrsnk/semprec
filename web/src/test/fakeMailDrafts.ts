import { OperationError } from "../api/genericOperations.js";
import type {
  CreateMailDraftRequest,
  EmailDraft,
  MailDraftFields,
  MailDraftOperations,
  MailDraftRecipient,
} from "../api/mailDraftOperations.js";
import type { FakeBackend } from "./fakeOperations.js";

/**
 * What a reply to one received message is prefilled with. The real backend computes this from the
 * message's mail metadata; the fake is told the answer, per source message. A message missing here
 * has no metadata, and replying to it is refused the way the backend refuses it.
 */
export interface FakeReplySource {
  /** The alias the message was delivered to — the reply's sending address. */
  from: string;
  replyTo: MailDraftRecipient[];
  replyAllTo: MailDraftRecipient[];
  subject: string;
  quote: string;
  threadId: string;
}

export type FakeMailDraftCall =
  | { kind: "create"; request: CreateMailDraftRequest }
  | { kind: "update"; draftId: string; version: string; fields: Partial<MailDraftFields> }
  | { kind: "discard"; draftId: string }
  | { kind: "send"; draftId: string };

export interface FakeMailModule {
  emailsDatabaseId: string;
  foldersDatabaseId: string;
  folderRelationKey: string;
  replySources: Record<string, FakeReplySource>;
  /** When set, a send is refused with this message, as the backend refuses one SMTP would not take. */
  rejectSend?: string | null;
  /** Every draft that exists and has not been discarded, as the backend currently holds it. */
  drafts: EmailDraft[];
  discarded: string[];
  /** Each sent draft, as it was when it was sent. */
  sent: EmailDraft[];
  /** Every request the client made, in order. */
  calls: FakeMailDraftCall[];
}

/**
 * An in-memory stand-in for the backend's `/api/mail/drafts` routes over the same fake backend
 * the generic operations read, so a draft is an Emails item in Drafts, a send moves it to Sent,
 * and a discard moves it to Trash — observable in the next generic read. It refuses what the
 * backend refuses where the client can tell the difference: an unregistered From address, a stale
 * version, a change of mailbox, a reply to a message without metadata, a rejected send.
 */
export function createFakeMailDrafts(backend: FakeBackend): MailDraftOperations {
  let nextId = 0;
  let nextVersion = 0;

  const module = (): FakeMailModule => {
    if (!backend.mail) throw new OperationError("unavailable", "The mail module is not installed", 501);
    return backend.mail;
  };

  const folderOf = (mail: FakeMailModule, mailboxId: string, purpose: string): string => {
    const folder = backend.items.find(
      (item) =>
        item.databaseId === mail.foldersDatabaseId &&
        item.properties.specialPurpose === purpose &&
        backend.relations.some(
          (edge) => edge.property === "mailbox" && edge.itemId === item.id && edge.targetItemId === mailboxId,
        ),
    );
    if (!folder) throw new OperationError("retryable", `Mailbox ${mailboxId} has no ${purpose} folder`, 400);
    return folder.id;
  };

  const assertRegistered = (mailboxId: string, from: string) => {
    const mailbox = backend.items.find((item) => item.id === mailboxId);
    if (!mailbox) throw new OperationError("unavailable", "Mailbox not found", 404);
    const registered = String(mailbox.properties.addresses ?? "")
      .split(/[\n,]/)
      .map((entry) => entry.trim().toLowerCase());
    if (!registered.includes(from.trim().toLowerCase())) {
      throw new OperationError(
        "unavailable",
        `The from address is not a registered address of mailbox ${mailboxId}`,
        403,
      );
    }
  };

  const moveTo = (mail: FakeMailModule, draftId: string, folderId: string) => {
    backend.relations = backend.relations.filter(
      (edge) => !(edge.property === mail.folderRelationKey && edge.itemId === draftId),
    );
    backend.relations.push({ property: mail.folderRelationKey, itemId: draftId, targetItemId: folderId });
  };

  const store = (mail: FakeMailModule, draft: EmailDraft) => {
    mail.drafts = [...mail.drafts.filter((existing) => existing.id !== draft.id), draft];
    const properties = { name: draft.subject, sender: draft.from, recipients: "", body: draft.body };
    const item = backend.items.find((candidate) => candidate.id === draft.id);
    if (item) item.properties = properties;
    else backend.items.push({ id: draft.id, databaseId: mail.emailsDatabaseId, properties });
  };

  const unsent = (mail: FakeMailModule, draftId: string): EmailDraft => {
    const draft = mail.drafts.find((candidate) => candidate.id === draftId);
    if (!draft) throw new OperationError("unavailable", "Draft not found", 404);
    return draft;
  };

  const version = () => `v${++nextVersion}`;

  return {
    async create(request) {
      const mail = module();
      mail.calls.push({ kind: "create", request });
      const base = {
        id: `draft-${++nextId}`,
        mailboxId: request.mailboxId,
        bcc: [],
        version: version(),
        updatedAt: "2026-03-03T10:00:00.000Z",
        sentAt: null,
      };
      let draft: EmailDraft;
      if (request.mode === "new") {
        const { mailboxId: _mailboxId, mode, threadId, ...fields } = request;
        assertRegistered(request.mailboxId, fields.from);
        draft = { ...base, ...fields, mode, threadId, sourceEmailId: null };
      } else {
        const source = mail.replySources[request.sourceEmailId];
        if (!source) throw new OperationError("unavailable", "Source message not found", 404);
        draft = {
          ...base,
          from: source.from,
          to: request.mode === "replyAll" ? source.replyAllTo : source.replyTo,
          cc: [],
          subject: source.subject,
          body: `${request.body}\n\n${source.quote}`,
          threadId: source.threadId,
          mode: request.mode,
          sourceEmailId: request.sourceEmailId,
        };
      }
      store(mail, draft);
      moveTo(mail, draft.id, folderOf(mail, draft.mailboxId, "drafts"));
      return draft;
    },

    async update(draftId, ifVersion, fields) {
      const mail = module();
      mail.calls.push({ kind: "update", draftId, version: ifVersion, fields });
      const draft = unsent(mail, draftId);
      if (ifVersion !== draft.version) {
        throw new OperationError("retryable", "Draft was modified since ifVersion was read", 409);
      }
      if (fields.from !== undefined) assertRegistered(draft.mailboxId, fields.from);
      const updated = { ...draft, ...fields, version: version() };
      store(mail, updated);
      return updated;
    },

    async discard(draftId) {
      const mail = module();
      mail.calls.push({ kind: "discard", draftId });
      const draft = unsent(mail, draftId);
      mail.drafts = mail.drafts.filter((candidate) => candidate.id !== draftId);
      mail.discarded.push(draftId);
      moveTo(mail, draftId, folderOf(mail, draft.mailboxId, "trash"));
    },

    async send(draftId) {
      const mail = module();
      mail.calls.push({ kind: "send", draftId });
      const draft = unsent(mail, draftId);
      if (mail.rejectSend) throw new OperationError("retryable", mail.rejectSend, 400);
      const sentAt = "2026-03-03T11:00:00.000Z";
      const mailbox = backend.items.find((item) => item.id === draft.mailboxId);
      mail.drafts = mail.drafts.filter((candidate) => candidate.id !== draftId);
      mail.sent.push({ ...draft, sentAt });
      moveTo(mail, draftId, folderOf(mail, draft.mailboxId, "sent"));
      return {
        emailId: draftId,
        threadId: draft.threadId ?? `thread-${draftId}`,
        sentAt,
        mailbox: { id: draft.mailboxId, name: String(mailbox?.properties.name ?? "") },
      };
    },
  };
}
