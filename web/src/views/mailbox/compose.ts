import { OperationError, toOperationError, type Item } from "../../api/genericOperations.js";
import type {
  EmailDraft,
  MailDraftFields,
  MailDraftOperations,
  MailDraftRecipient,
} from "../../api/mailDraftOperations.js";
import {
  formatAddressList,
  normalizeAddress,
  parseAddress,
  parseAddressList,
  parseAddressListProperty,
  type MailAddress,
} from "./addresses.js";

/**
 * Everything compose does that is not React: which alias a message is sent from, and how the
 * window's content reaches the backend's draft — created on the first save or send, updated with
 * the version last read after that, sent, or discarded. The UI owns only the window, the fields
 * and when to call these.
 */

export type ComposeMode = "new" | "reply" | "replyAll";

export interface ComposeState {
  mode: ComposeMode;
  /** The alias the message is sent from — always one of the registered ones, never free text. */
  fromAddress: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  /** Whether the Cc/Bcc fields are shown. */
  showCopies: boolean;
  /**
   * The backend's draft as it last answered. `null` for a new message until its first save or
   * send; a reply has one from the start, since the backend computes its recipients, subject,
   * quote and threading when it creates it.
   */
  draft: EmailDraft | null;
  /**
   * Whether the user has kept the draft — saved it, or attempted to send it. Closing keeps a kept
   * draft in Drafts and discards one that only exists because a reply was started.
   */
  kept: boolean;
  minimized: boolean;
  status: "editing" | "saving" | "sending" | "discarding" | "sent";
  error: ComposeError | null;
}

/**
 * Why the last attempt did not go out. `invalid` is the window's own check on what has been
 * typed; `failed` is the backend's answer, message and all — a rejected send has to say what
 * the backend said (an unregistered From alias and a dead SMTP host are not the same problem).
 */
export type ComposeError = { kind: "invalid"; problem: ComposeProblem } | { kind: "failed"; message: string };

export type ComposeProblem = "noSender" | "noRecipients";

/** One address the user may send from: the registered aliases of a mailbox, in listed order. */
export interface AliasOption {
  address: string;
  mailboxItemId: string;
  mailboxName: string;
}

/** `Mailboxes.addresses` is the registered-alias list the backend checks a draft's From against, so it is also the only thing the From dropdown offers. */
export function aliasOptions(mailboxes: readonly Item[]): AliasOption[] {
  const options: AliasOption[] = [];
  const seen = new Set<string>();
  for (const mailbox of mailboxes) {
    const name = typeof mailbox.properties.name === "string" ? mailbox.properties.name : mailbox.id;
    for (const address of parseAddressListProperty(mailbox.properties.addresses)) {
      const key = normalizeAddress(address);
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({ address, mailboxItemId: mailbox.id, mailboxName: name });
    }
  }
  return options;
}

export function findAlias(aliases: readonly AliasOption[], address: string): AliasOption | null {
  const wanted = normalizeAddress(address);
  return aliases.find((alias) => normalizeAddress(alias.address) === wanted) ?? null;
}

export interface FromDefaultInput {
  aliases: readonly AliasOption[];
  /** The mailbox the folder being read belongs to. */
  contextMailboxItemId?: string | null;
}

/**
 * The From default of a new message: the current folder's account, otherwise the primary
 * address (the first registered alias, which is what the backend treats as primary too). Only
 * ever a default: the dropdown keeps every alias selectable afterwards. A reply's From is the
 * backend's choice instead (the alias the message was delivered to).
 */
export function defaultFromAddress(input: FromDefaultInput): string {
  const { aliases } = input;
  if (input.contextMailboxItemId) {
    const contextAlias = aliases.find((alias) => alias.mailboxItemId === input.contextMailboxItemId);
    if (contextAlias) return contextAlias.address;
  }
  return aliases[0]?.address ?? "";
}

export function newCompose(fromAddress: string): ComposeState {
  return {
    mode: "new",
    fromAddress,
    to: "",
    cc: "",
    bcc: "",
    subject: "",
    body: "",
    showCopies: false,
    draft: null,
    kept: false,
    minimized: false,
    status: "editing",
    error: null,
  };
}

function toMailAddresses(recipients: readonly MailDraftRecipient[]): MailAddress[] {
  return recipients.map((recipient) =>
    recipient.name ? { name: recipient.name, address: recipient.address } : { address: recipient.address },
  );
}

function toRecipients(addresses: readonly MailAddress[]): MailDraftRecipient[] {
  return addresses.map((address) => ({ address: address.address, name: address.name ?? "" }));
}

function textProperty(message: Item, key: string): string {
  const value = message.properties[key];
  return typeof value === "string" ? value : "";
}

export function replySubject(subject: string): string {
  const trimmed = subject.trim();
  if (/^re:/i.test(trimmed)) return trimmed;
  return `Re: ${trimmed}`;
}

export interface LocalReplyInput {
  mode: Exclude<ComposeMode, "new">;
  message: Item;
  aliases: readonly AliasOption[];
  contextMailboxItemId?: string | null;
  /** The translated "{sender} wrote:" line the quote starts with. */
  attribution: string;
}

/**
 * A reply to a message the backend cannot start one for: one ingested before the mail metadata
 * existed, which the backend answers with 404. Its derived display text is all there is, so the
 * reply addresses the sender, a reply-all also the displayed recipients (minus the user's own
 * aliases), and the quote is built here. It has no draft until the first save or send, which
 * writes it as a new message — there are no threading headers to carry.
 */
export function localReplyCompose(input: LocalReplyInput): ComposeState {
  const self = new Set(input.aliases.map((alias) => normalizeAddress(alias.address)));
  const sender = parseAddress(textProperty(input.message, "sender"));
  const candidates = [
    ...(sender ? [sender] : []),
    ...(input.mode === "replyAll" ? parseAddressList(textProperty(input.message, "recipients")) : []),
  ];
  const seen = new Set<string>();
  const to = candidates.filter((address) => {
    const key = normalizeAddress(address.address);
    if (self.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const quoted = textProperty(input.message, "body")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return {
    ...newCompose(defaultFromAddress({ aliases: input.aliases, contextMailboxItemId: input.contextMailboxItemId })),
    mode: input.mode,
    to: formatAddressList(to),
    subject: replySubject(textProperty(input.message, "name")),
    body: `\n\n${input.attribution}\n${quoted}\n`,
  };
}

export interface StartReplyInput extends LocalReplyInput {
  /** The mailbox the reply is written from; the backend picks the alias within it. */
  mailboxItemId: string;
}

/**
 * A reply, ready to type into. The backend creates it from the message being answered — who it
 * goes to, the subject, the quote, the sending alias and the threading headers — and the window
 * opens on exactly what it answered. A message the backend has no metadata for (404) gets the
 * reply `localReplyCompose` builds from its display text instead.
 */
export async function startReplyCompose(drafts: MailDraftOperations, input: StartReplyInput): Promise<ComposeState> {
  let draft: EmailDraft;
  try {
    draft = await drafts.create({
      mailboxId: input.mailboxItemId,
      mode: input.mode,
      sourceEmailId: input.message.id,
      body: "",
    });
  } catch (error) {
    if (error instanceof OperationError && error.status === 404) return localReplyCompose(input);
    throw error;
  }
  return {
    ...newCompose(draft.from),
    mode: input.mode,
    to: formatAddressList(toMailAddresses(draft.to)),
    cc: formatAddressList(toMailAddresses(draft.cc)),
    bcc: formatAddressList(toMailAddresses(draft.bcc)),
    showCopies: draft.cc.length + draft.bcc.length > 0,
    subject: draft.subject,
    body: draft.body,
    draft,
  };
}

function failed(state: ComposeState, error: unknown, draft: EmailDraft | null, kept: boolean): ComposeState {
  return {
    ...state,
    draft,
    kept,
    status: "editing",
    error: { kind: "failed", message: toOperationError(error).message },
  };
}

/**
 * Switching between Reply and Reply to all on a reply already being written changes who it goes
 * to, and nothing else. The backend computes recipients only when it creates a draft, so the
 * switch creates the other mode's draft, takes its recipients, and discards the one it replaces;
 * the subject, body and alias in the window stay as typed. A kept draft is written again at once,
 * so what was saved does not exist only in the window. A reply built locally (no draft yet) just
 * recomputes its recipients.
 */
export async function switchReplyMode(
  drafts: MailDraftOperations,
  state: ComposeState,
  input: LocalReplyInput,
): Promise<ComposeState> {
  const replaced = state.draft;
  if (!replaced) {
    const local = localReplyCompose(input);
    return { ...state, mode: input.mode, to: local.to, status: "editing", error: null };
  }
  let replacement: EmailDraft;
  try {
    replacement = await drafts.create({
      mailboxId: replaced.mailboxId,
      mode: input.mode,
      sourceEmailId: input.message.id,
      body: "",
    });
  } catch (error) {
    return failed(state, error, replaced, state.kept);
  }
  const switched: ComposeState = {
    ...state,
    mode: input.mode,
    to: formatAddressList(toMailAddresses(replacement.to)),
    cc: formatAddressList(toMailAddresses(replacement.cc)),
    showCopies: state.showCopies || replacement.cc.length > 0,
    draft: replacement,
  };
  try {
    await drafts.discard(replaced.id);
  } catch (error) {
    return failed(switched, error, replacement, state.kept);
  }
  if (!state.kept) return { ...switched, status: "editing", error: null };
  return saveComposeDraft(drafts, switched, input.aliases);
}

type FieldsResult = { ok: true; alias: AliasOption; fields: MailDraftFields } | { ok: false; problem: ComposeProblem };

/**
 * The draft content the window holds. Saving is allowed to be incomplete in every way except
 * the sender — which mailbox the draft belongs to follows from the alias — while sending
 * additionally needs somewhere to go.
 */
export function composeFields(
  state: ComposeState,
  aliases: readonly AliasOption[],
  options: { requireRecipients: boolean },
): FieldsResult {
  const alias = findAlias(aliases, state.fromAddress);
  if (!alias) return { ok: false, problem: "noSender" };

  const to = toRecipients(parseAddressList(state.to));
  const cc = toRecipients(parseAddressList(state.cc));
  const bcc = toRecipients(parseAddressList(state.bcc));
  if (options.requireRecipients && to.length + cc.length + bcc.length === 0)
    return { ok: false, problem: "noRecipients" };

  return {
    ok: true,
    alias,
    fields: { from: alias.address, to, cc, bcc, subject: state.subject, body: state.body },
  };
}

function sameRecipients(left: readonly MailDraftRecipient[], right: readonly MailDraftRecipient[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (recipient, index) =>
        normalizeAddress(recipient.address) === normalizeAddress(right[index]?.address ?? "") &&
        recipient.name === right[index]?.name,
    )
  );
}

/** The fields the window holds that differ from the draft the backend last answered. */
export function pendingChanges(draft: EmailDraft, fields: MailDraftFields): Partial<MailDraftFields> {
  const changes: Partial<MailDraftFields> = {};
  if (normalizeAddress(draft.from) !== normalizeAddress(fields.from)) changes.from = fields.from;
  if (!sameRecipients(draft.to, fields.to)) changes.to = fields.to;
  if (!sameRecipients(draft.cc, fields.cc)) changes.cc = fields.cc;
  if (!sameRecipients(draft.bcc, fields.bcc)) changes.bcc = fields.bcc;
  if (draft.subject !== fields.subject) changes.subject = fields.subject;
  if (draft.body !== fields.body) changes.body = fields.body;
  return changes;
}

/**
 * Brings the backend's draft in line with the window and reports each draft it answers through
 * `onDraft`, so a failure part-way still leaves the window pointing at the draft that exists.
 *
 * - No draft yet: a new message's first write creates it in the alias's mailbox.
 * - A draft in the alias's mailbox: only the changed fields are sent, with its last version.
 * - A draft in another mailbox (the user picked an alias of another account): a draft never
 *   changes mailbox, so the content is written into a new draft there — a reply is recreated
 *   from its source, keeping its thread and threading headers — and the old draft is discarded.
 */
async function writeDraft(
  drafts: MailDraftOperations,
  state: ComposeState,
  alias: AliasOption,
  fields: MailDraftFields,
  onDraft: (draft: EmailDraft) => void,
): Promise<EmailDraft> {
  const current = state.draft;
  if (current && current.mailboxId === alias.mailboxItemId) {
    const changes = pendingChanges(current, fields);
    if (Object.keys(changes).length === 0) return current;
    const updated = await drafts.update(current.id, current.version, changes);
    onDraft(updated);
    return updated;
  }

  let written: EmailDraft;
  if (state.mode !== "new" && current?.sourceEmailId) {
    const created = await drafts.create({
      mailboxId: alias.mailboxItemId,
      mode: state.mode,
      sourceEmailId: current.sourceEmailId,
      body: "",
    });
    onDraft(created);
    written = await drafts.update(created.id, created.version, fields);
  } else {
    written = await drafts.create({ mailboxId: alias.mailboxItemId, mode: "new", threadId: null, ...fields });
  }
  onDraft(written);
  if (current) await drafts.discard(current.id);
  return written;
}

/** Saving the content as a draft: created on the first save, updated with the last version after that. */
export async function saveComposeDraft(
  drafts: MailDraftOperations,
  state: ComposeState,
  aliases: readonly AliasOption[],
): Promise<ComposeState> {
  const result = composeFields(state, aliases, { requireRecipients: false });
  if (!result.ok) return { ...state, status: "editing", error: { kind: "invalid", problem: result.problem } };

  let draft = state.draft;
  try {
    draft = await writeDraft(drafts, state, result.alias, result.fields, (answered) => {
      draft = answered;
    });
    return { ...state, draft, kept: true, status: "editing", error: null };
  } catch (error) {
    return failed(state, error, draft, state.kept || draft !== state.draft);
  }
}

/**
 * Sending: whatever the window holds that the draft does not is written first, then the draft
 * is sent. That ordering is what makes a rejected send recoverable: whatever the backend refuses
 * (an unregistered From alias, a stale version, SMTP itself), the draft survives and is kept, the
 * window stays open with everything still editable, and the refusal is shown as it was given.
 */
export async function sendCompose(
  drafts: MailDraftOperations,
  state: ComposeState,
  aliases: readonly AliasOption[],
): Promise<ComposeState> {
  const result = composeFields(state, aliases, { requireRecipients: true });
  if (!result.ok) return { ...state, status: "editing", error: { kind: "invalid", problem: result.problem } };

  let draft = state.draft;
  try {
    draft = await writeDraft(drafts, state, result.alias, result.fields, (answered) => {
      draft = answered;
    });
    await drafts.send(draft.id);
    return { ...state, draft, kept: true, status: "sent", error: null };
  } catch (error) {
    return failed(state, error, draft, state.kept || draft !== null);
  }
}

/**
 * Closing the window. A draft the user never kept — the one a started reply was created as — is
 * discarded, so starting a reply and closing it leaves nothing in Drafts; a kept draft stays.
 * Resolves `null` once the window may go, or the state with the failure when the discard was
 * refused. A draft the backend no longer has is already gone, which is what closing wanted.
 */
export async function closeCompose(drafts: MailDraftOperations, state: ComposeState): Promise<ComposeState | null> {
  if (!state.draft || state.kept) return null;
  try {
    await drafts.discard(state.draft.id);
    return null;
  } catch (error) {
    if (error instanceof OperationError && error.status === 404) return null;
    return failed(state, error, state.draft, state.kept);
  }
}
