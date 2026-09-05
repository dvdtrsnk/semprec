import { toOperationError, type GenericOperations, type Item } from "../../api/genericOperations.js";
import { formatAddressList, normalizeAddress, parseAddressList, parseAddressListProperty, type MailAddress } from "./addresses.js";
import { createDraft, sendDraft, type DraftPayload, type MessageEnvelope } from "./mailOperations.js";

/**
 * Everything compose does that is not React: which addresses a reply goes to, which alias it
 * is sent from, and the payload the draft/send operations are called with. The UI owns only
 * the window, the fields and when to call these.
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
  /** Whether the Cc/Bcc fields are shown; a reply-all opens with them already in use. */
  showCopies: boolean;
  /** Set once the content has been saved as a draft — including by a send that was then rejected. */
  draftItemId: string | null;
  inReplyTo: string | null;
  references: string[];
  minimized: boolean;
  status: "editing" | "saving" | "sending" | "sent";
  error: ComposeError | null;
}

/**
 * Why the last attempt did not go out. `invalid` is the window's own check on what has been
 * typed; `failed` is the backend's answer, message and all — a rejected send has to say what
 * the backend said (an unregistered From alias and a dead SMTP host are not the same problem).
 */
export type ComposeError = { kind: "invalid"; problem: ComposeProblem } | { kind: "failed"; message: string };

/** One address the user may send from: the registered aliases of a mailbox, in listed order. */
export interface AliasOption {
  address: string;
  mailboxItemId: string;
  mailboxName: string;
}

/** `Mailboxes.addresses` is the registered-alias list the backend's send path checks against, so it is also the only thing the From dropdown offers. */
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
  /** The alias the message being replied to was delivered to, as persisted at ingest. */
  deliveredToAddress?: string | null;
  /** The mailbox the folder being read belongs to — the account context when there is no reply. */
  contextMailboxItemId?: string | null;
}

/**
 * The From default: the persisted receiving alias of the message being replied to, otherwise
 * the current folder's account, otherwise the primary address (the first registered alias,
 * which is what the backend treats as primary too — mail/deliveredTo.ts). Only ever a default:
 * the dropdown keeps every alias selectable afterwards.
 */
export function defaultFromAddress(input: FromDefaultInput): string {
  const { aliases } = input;
  if (aliases.length === 0) return "";
  if (input.deliveredToAddress) {
    const delivered = findAlias(aliases, input.deliveredToAddress);
    if (delivered) return delivered.address;
  }
  if (input.contextMailboxItemId) {
    const contextAlias = aliases.find((alias) => alias.mailboxItemId === input.contextMailboxItemId);
    if (contextAlias) return contextAlias.address;
  }
  return aliases[0]?.address ?? "";
}

/** Everything the user could send as — a reply must not address an alias of the user's own back to them. */
function isSelf(address: MailAddress, selfAddresses: ReadonlySet<string>): boolean {
  return selfAddresses.has(normalizeAddress(address.address));
}

export interface ReplyRecipients {
  to: MailAddress[];
  cc: MailAddress[];
}

/**
 * Who a reply goes to, taken from the stored envelope rather than from the derived display
 * text: a plain reply answers the sender; a reply-all adds everyone else the message reached
 * through To and Cc. The user's own aliases are dropped, and every address appears once —
 * being both in To and in Cc of the original must not produce two copies.
 */
export function replyRecipients(envelope: MessageEnvelope["envelope"], mode: ComposeMode, selfAddresses: readonly string[]): ReplyRecipients {
  const self = new Set(selfAddresses.map(normalizeAddress));
  const used = new Set<string>();
  const take = (addresses: readonly MailAddress[], skipSelf: boolean): MailAddress[] => {
    const picked: MailAddress[] = [];
    for (const address of addresses) {
      const key = normalizeAddress(address.address);
      if (used.has(key)) continue;
      if (skipSelf && isSelf(address, self)) continue;
      used.add(key);
      picked.push(address);
    }
    return picked;
  };

  // Replying to one's own sent message keeps its recipients rather than answering oneself.
  const from = envelope.from;
  const to = from && !isSelf(from, self) ? take([from], false) : take(envelope.to, true);
  if (mode !== "replyAll") return { to, cc: [] };
  return { to: [...to, ...take(envelope.to, true)], cc: take(envelope.cc, true) };
}

export function replySubject(subject: string): string {
  const trimmed = subject.trim();
  if (/^re:/i.test(trimmed)) return trimmed;
  return `Re: ${trimmed}`;
}

/** The original message quoted under the reply, with the caller's translated attribution line on top. */
export function quotedBody(attribution: string, body: string): string {
  const quoted = body
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `\n\n${attribution}\n${quoted}\n`;
}

function emptyCompose(mode: ComposeMode, fromAddress: string): ComposeState {
  return {
    mode,
    fromAddress,
    to: "",
    cc: "",
    bcc: "",
    subject: "",
    body: "",
    showCopies: false,
    draftItemId: null,
    inReplyTo: null,
    references: [],
    minimized: false,
    status: "editing",
    error: null,
  };
}

export function newCompose(fromAddress: string): ComposeState {
  return emptyCompose("new", fromAddress);
}

export interface ReplyComposeInput {
  mode: Exclude<ComposeMode, "new">;
  message: Item;
  envelope: MessageEnvelope;
  aliases: readonly AliasOption[];
  contextMailboxItemId?: string | null;
  attribution: string;
}

/** A reply, ready to type into: recipients, subject, quoted body and the From alias all derived. */
export function replyCompose(input: ReplyComposeInput): ComposeState {
  const selfAddresses = input.aliases.map((alias) => alias.address);
  const { to, cc } = replyRecipients(input.envelope.envelope, input.mode, selfAddresses);
  const subject = typeof input.message.properties.name === "string" ? input.message.properties.name : "";
  const body = typeof input.message.properties.body === "string" ? input.message.properties.body : "";
  const fromAddress = defaultFromAddress({
    aliases: input.aliases,
    deliveredToAddress: input.envelope.deliveredToAddress,
    contextMailboxItemId: input.contextMailboxItemId,
  });

  return {
    ...emptyCompose(input.mode, fromAddress),
    to: formatAddressList(to),
    cc: formatAddressList(cc),
    showCopies: cc.length > 0,
    subject: replySubject(subject),
    body: quotedBody(input.attribution, body),
    // RFC 5322 threading: the reply points at the message it answers and carries its
    // References chain forward, so the thread survives on the recipient's side too.
    inReplyTo: input.envelope.messageId,
    references: input.envelope.messageId ? [...input.envelope.references, input.envelope.messageId] : input.envelope.references,
  };
}

export type ComposeProblem = "noSender" | "noRecipients";

export type ComposePayloadResult = { ok: true; payload: DraftPayload } | { ok: false; problem: ComposeProblem };

/**
 * The payload both `email.draft.create` and `email.send` are called with. Saving a draft is
 * allowed to be incomplete in every way except the sender — which mailbox's Drafts folder it
 * belongs in follows from the alias — while sending additionally needs somewhere to go.
 */
export function composePayload(state: ComposeState, aliases: readonly AliasOption[], options: { requireRecipients: boolean }): ComposePayloadResult {
  const alias = findAlias(aliases, state.fromAddress);
  if (!alias) return { ok: false, problem: "noSender" };

  const to = parseAddressList(state.to);
  const cc = parseAddressList(state.cc);
  const bcc = parseAddressList(state.bcc);
  if (options.requireRecipients && to.length + cc.length + bcc.length === 0) return { ok: false, problem: "noRecipients" };

  return {
    ok: true,
    payload: {
      mailboxItemId: alias.mailboxItemId,
      subject: state.subject,
      from: { address: alias.address },
      to,
      cc,
      bcc,
      bodyText: state.body,
      inReplyTo: state.inReplyTo,
      references: state.references,
    },
  };
}

/**
 * Saving the content as a draft. The mail module's draft surface is create-only
 * (`email.draft.create`, issue #95 — there is no draft-update operation), so a compose session
 * owns exactly one draft item: the first save creates it, and everything typed afterwards
 * stays in the window and goes out with the send, which writes the final content onto that
 * same item (mail/send.ts). The UI says so rather than silently creating a second draft.
 */
export async function saveComposeDraft(operations: GenericOperations, state: ComposeState, aliases: readonly AliasOption[]): Promise<ComposeState> {
  if (state.draftItemId) return { ...state, status: "editing", error: null };

  const result = composePayload(state, aliases, { requireRecipients: false });
  if (!result.ok) return { ...state, status: "editing", error: { kind: "invalid", problem: result.problem } };

  try {
    const draftItemId = await createDraft(operations, result.payload);
    return { ...state, draftItemId, status: "editing", error: null };
  } catch (error) {
    return { ...state, status: "editing", error: { kind: "failed", message: toOperationError(error).message } };
  }
}

/**
 * Sending. The draft is created first when the content has not been saved yet, since
 * `email.send` sends an existing draft item — and that ordering is what makes a rejected send
 * recoverable: whatever the backend refuses (an unregistered From alias, a missing autonomous
 * grant, SMTP itself), the draft item survives, the window stays open with everything still
 * editable, and the refusal is shown as it was given.
 */
export async function sendCompose(operations: GenericOperations, state: ComposeState, aliases: readonly AliasOption[]): Promise<ComposeState> {
  const result = composePayload(state, aliases, { requireRecipients: true });
  if (!result.ok) return { ...state, status: "editing", error: { kind: "invalid", problem: result.problem } };

  let draftItemId = state.draftItemId;
  try {
    if (!draftItemId) draftItemId = await createDraft(operations, result.payload);
    await sendDraft(operations, draftItemId, result.payload);
    return { ...state, draftItemId, status: "sent", error: null };
  } catch (error) {
    return { ...state, draftItemId, status: "editing", error: { kind: "failed", message: toOperationError(error).message } };
  }
}
