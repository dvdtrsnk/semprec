// Issue gh-1927: the three draft agent tools of the mail module, declared in `mailModuleManifest.ts`. `mail.thread.get`
// reads a conversation as text, `mail.draft.create` starts a draft (a new mail, a reply, a reply-all or a forward) and
// `mail.draft.update` rewrites the text of an open one. A draft is kept in Semprec and these three never send it, so
// none of them needs an approval (docs/adr/2026-10-28-module-agent-tools-approval-and-grants.md). Issue gh-1949 adds
// `mail.draft.send`, which does not send either: it files the approval request of the send. The handlers take the run,
// its project and its user from the stored run, never from an argument, and answer in the shape of the other module
// tools: a result string that holds JSON (the send tool's is the sentence of a deferred tool), and an `error` flag. Every
// write goes through the draft operations of `draft.ts` and `mailDraftPrefill.ts`, and so through the choke point.
// Constrained by: docs/adr/2026-09-10-choke-point-api-for-state-writes.md,
// docs/adr/2026-10-28-module-agent-tools-approval-and-grants.md,
// docs/adr/2026-11-14-an-agents-mail-send-is-an-approval-request-of-its-own-kind-sent-as-the-user.md,
// docs/adr/2026-11-14-the-mail-send-tool-is-declared-without-deferral-and-files-its-own-approval-request.md
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { getAgentRun, type AgentRunRow } from "../agentRuns/agentRunsStore.js";
import { getItemById } from "../chokePoint/itemsStore.js";
import { requireSingleRow, withTransaction } from "../db/pool.js";
import { ChokePointError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import { notifyAgentRunDelta } from "../realtimeHook.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { parseAddressListProperty } from "./addressListParsing.js";
import { readMaxFileSizeBytes } from "./blobStorage.js";
import {
  createEmailDraftInMailbox,
  lockUnsentDraft,
  updateEmailDraft,
  type EmailDraftView,
  type MailDraftWriteContext,
  type MailDraftWriter,
} from "./draft.js";
import { draftBody, draftRecipients, draftSubject } from "./mailDraftFields.js";
import { createPrefilledEmailDraft, sendingAddress } from "./mailDraftPrefill.js";
import { findOpenAgentDraftOfThread, MAIL_DRAFT_MODES } from "./mailDraftsStore.js";
import { getMailMessageMetaByItemId, resolveMergedThreadId } from "./mailMessageMetaStore.js";
import { resolveMailModuleIds } from "./mailModuleIds.js";
import { requestMailSendApproval } from "./mailSendApproval.js";
import { getMailThreadDetail } from "./mailThreadDetail.js";

/** The most of one message's text that `mail.thread.get` returns. */
const MAX_MESSAGE_TEXT_LENGTH = 20_000;
/** The most text of all messages that `mail.thread.get` returns; the newest messages are served first. */
const MAX_THREAD_TEXT_LENGTH = 200_000;

export const mailThreadGetArgsSchema = z.strictObject({ threadId: z.uuid() });

/**
 * The arguments of `mail.draft.create`. A `new` draft takes `mailboxId` and the recipients, the subject and the body as
 * given. `reply`, `replyAll` and `forward` take the source message from `sourceEmailId`, or from `threadId`, whose newest
 * message that is neither a draft nor sent by the user is answered (the newest one that is not a draft when there is
 * none), and derive the mailbox and the sending address from it: a `mailboxId` given for those is ignored. `to`, `cc`,
 * `bcc` and `subject` are the agent's to give in every mode (the agent has no other step to address a forward): in a
 * prefilled mode a value that is given replaces the one computed from the source (`to: []` clears the recipients, a
 * `subject` is taken as it is, without a `Re: ` prefix) and one that is left out stays as computed. `body` is the
 * agent's own text, which the quote of the source follows.
 */
export const mailDraftCreateArgsSchema = z.strictObject({
  mode: z.enum(MAIL_DRAFT_MODES),
  threadId: z.uuid().optional(),
  sourceEmailId: z.uuid().optional(),
  mailboxId: z.uuid().optional(),
  to: draftRecipients.optional(),
  cc: draftRecipients.optional(),
  bcc: draftRecipients.optional(),
  subject: draftSubject.optional(),
  body: draftBody,
});

export const mailDraftUpdateArgsSchema = z.strictObject({
  draftId: z.uuid(),
  body: draftBody,
  // The write refuses a blank subject (its title rule); refusing it here keeps that refusal ahead of the body frame.
  subject: draftSubject.refine((value) => value.trim() !== "").optional(),
});

export const mailDraftSendArgsSchema = z.strictObject({ draftId: z.uuid() });

export interface MailAgentToolResult {
  error: boolean;
  result: string;
  /**
   * The id of the approval request the call filed (issue gh-1949: `mail.draft.send` alone). The session writes it into the
   * tool result's `details.approvalRequestId`, which is what makes the run timeline show the step as an approval.
   */
  approvalRequestId?: string;
}

export type MailAgentTool = (runId: string, args: unknown) => Promise<MailAgentToolResult>;

/**
 * Raised by `mail.draft.create` in a reply mode when the source message's thread already has an open agent draft
 * (issue gh-1941). It names that draft in `details.draftId`, which the refusal puts in its answer, so the agent updates
 * the draft with `mail.draft.update` instead of making another.
 */
class OpenAgentDraftConflictError extends ConflictError {
  constructor(draftId: string) {
    super(
      `The thread already has an open agent draft (${draftId}); update it with mail.draft.update instead of creating another`,
      { draftId },
      "mail_agent_draft_exists",
    );
    this.name = "OpenAgentDraftConflictError";
  }
}

/**
 * Raised by `mail.draft.update` when a run that no person asked for (a heartbeat run, or one a heartbeat run delegated to)
 * would replace a draft whose last editor is the user (issue gh-1941). It names the draft in `details.draftId`.
 */
class DraftEditedByUserError extends ConflictError {
  constructor(draftId: string) {
    super(
      `The draft ${draftId} was edited by the user and is not overwritten by a run no person asked for`,
      { draftId },
      "mail_draft_edited_by_user",
    );
    this.name = "DraftEditedByUserError";
  }
}

/** The member `key` of a refusal's `details` when it is a string, else `undefined`. */
function detailText(error: ChokePointError, key: "field" | "draftId"): string | undefined {
  if (typeof error.details !== "object" || error.details === null || !(key in error.details)) return undefined;
  const value: unknown = Reflect.get(error.details, key);
  return typeof value === "string" ? value : undefined;
}

/** The error result of a refusal: the HTTP status the route would answer, its error code and message. */
function refusal(error: ChokePointError): MailAgentToolResult {
  const field = detailText(error, "field");
  const draftId = detailText(error, "draftId");
  return {
    error: true,
    result: JSON.stringify({
      status: error.status,
      error: error.code,
      message: error.message,
      ...(field === undefined ? {} : { field }),
      ...(draftId === undefined ? {} : { draftId }),
    }),
  };
}

/**
 * Runs `work`, answering a `ChokePointError` it throws (a 400, 403, 404 or 409 of the checks and of the operations) as
 * an error result. Whatever else it throws is not an answer of this tool and propagates, so the session reports a failed
 * tool and the transaction of `work` is rolled back.
 */
async function answering(work: () => Promise<MailAgentToolResult>): Promise<MailAgentToolResult> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof ChokePointError) return refusal(err);
    throw err;
  }
}

interface RunContext {
  run: AgentRunRow;
  writer: MailDraftWriter;
  actorUserId: string;
  conversationId?: string;
}

/**
 * The run's stored project, user and Semp thread. An unknown run is a 404 and a run without a project a 403: the
 * capabilities of the tools are granted per project, so a run that has none holds none.
 */
async function runContext(client: PoolClient, runId: string): Promise<RunContext> {
  const run = await getAgentRun(client, runId);
  if (!run) throw new NotFoundError("Run not found");
  if (run.projectItemId === null) throw new ForbiddenError("The run has no project and so no access to mail");
  return {
    run,
    writer: {
      writerKind: "agent",
      agentRunId: runId,
      agentProjectItemId: run.projectItemId,
      onBehalfOfUserId: run.actorUserId,
    },
    actorUserId: run.actorUserId,
    ...(run.threadId === null ? {} : { conversationId: run.threadId }),
  };
}

/**
 * Whether `run`, or the run it was delegated from, was started by a heartbeat: nobody asked for it, so what it writes is
 * the agent's own initiative. A run of a chat turn or of an MCP client is a person's request.
 */
async function startedByHeartbeat(client: PoolClient, run: AgentRunRow): Promise<boolean> {
  const visited = new Set<string>();
  let current: AgentRunRow | null = run;
  while (current !== null && !visited.has(current.id)) {
    if (current.triggeredBy === "heartbeat") return true;
    visited.add(current.id);
    current = current.parentRunId === null ? null : await getAgentRun(client, current.parentRunId);
  }
  return false;
}

/** The cut of `text` to at most `max` code points, never half of a surrogate pair. */
function cutText(text: string, max: number): string {
  return Array.from(text).slice(0, max).join("");
}

/**
 * `mail.thread.get { threadId }` (issue gh-1927): the thread as `GET /api/mail/threads/:threadId` reads it, with every
 * message as text. A merged-away thread id resolves to the thread that absorbed it, and an unknown one, another
 * tenant's and a thread without a live message are the same 404. The answer is the thread's `threadId`, `subject`,
 * `lastMessageAt`, `messageCount`, `participants` (the people who wrote or received), `senderPerson`, `company`
 * and `project`, and its `messages`, oldest first: the `emailId`, `mailboxId`, `folderPurpose`, `isOwn`, `from`, `to`,
 * `cc`, `date`, the plain `bodyText` and the file names of the `attachments`. A body is cut to 20000 characters and the
 * bodies of all messages to 200000, the newest messages first; a message whose text was cut has `bodyTruncated`.
 * Nothing is written. It is read in one REPEATABLE READ transaction, so the answer describes one state of the thread.
 */
export function createMailThreadGetTool(pool: Pool): MailAgentTool {
  return async function mailThreadGet(runId, rawArgs) {
    const args = mailThreadGetArgsSchema.safeParse(rawArgs);
    if (!args.success) return refusal(new ValidationError("Invalid arguments"));
    return answering(() =>
      withTransaction(
        pool,
        async (client) => {
          await runContext(client, runId);
          const thread = await getMailThreadDetail(client, args.data.threadId, false);
          let remaining = MAX_THREAD_TEXT_LENGTH;
          const messages = [...thread.messages].reverse().map((message) => {
            const bodyText = cutText(message.bodyText, Math.max(0, Math.min(MAX_MESSAGE_TEXT_LENGTH, remaining)));
            remaining -= bodyText.length;
            return {
              emailId: message.emailId,
              mailboxId: message.mailboxId,
              folderPurpose: message.folderPurpose,
              isOwn: message.isOwn,
              from: message.from,
              to: message.to,
              cc: message.cc,
              date: message.date,
              bodyText,
              bodyTruncated: bodyText.length < message.bodyText.length,
              attachments: message.attachments.map((attachment) => attachment.filename),
            };
          });
          return {
            error: false,
            result: JSON.stringify({
              threadId: thread.threadId,
              subject: thread.subject,
              lastMessageAt: thread.lastMessageAt,
              messageCount: thread.messageCount,
              participants: thread.participants,
              senderPerson: thread.senderPerson,
              company: thread.company,
              project: thread.project,
              messages: messages.reverse(),
            }),
          };
        },
        { isolation: "repeatable_read" },
      ),
    );
  };
}

interface SourceMessage {
  emailId: string;
  mailboxId: string;
}

/**
 * The message a reply, reply-all or forward starts from, and the mailbox it is in. With `sourceEmailId` that message,
 * which must belong to `threadId` when that is given too (a 400 naming `sourceEmailId` otherwise); without it the newest
 * message of the thread that is not a draft and was not sent by the user, else the newest that is not a draft.
 * An unknown message or thread, and a thread without such a message, is a 404; a message that belongs to no mailbox
 * (one of the legacy migration) is a 400.
 */
async function findSourceMessage(
  client: PoolClient,
  args: { threadId?: string; sourceEmailId?: string },
): Promise<SourceMessage> {
  if (args.sourceEmailId === undefined) {
    if (args.threadId === undefined) {
      throw new ValidationError("A reply or a forward needs a threadId or a sourceEmailId", { field: "sourceEmailId" });
    }
    const { messages } = await getMailThreadDetail(client, args.threadId, false);
    const answerable = messages.filter((message) => message.folderPurpose !== "drafts");
    const newestFirst = [...answerable].reverse();
    const source = newestFirst.find((message) => !message.isOwn) ?? newestFirst[0];
    if (!source) throw new NotFoundError("The thread has no message to answer");
    if (source.mailboxId === null)
      throw new ValidationError("The message belongs to no mailbox", { field: "threadId" });
    return { emailId: source.emailId, mailboxId: source.mailboxId };
  }
  const meta = await getMailMessageMetaByItemId(client, args.sourceEmailId);
  if (!meta) throw new NotFoundError("Source message not found");
  if (args.threadId !== undefined) {
    const requested = await resolveMergedThreadId(client, args.threadId);
    if (requested === null) throw new NotFoundError("Thread not found");
    const actual = meta.threadId === null ? null : await resolveMergedThreadId(client, meta.threadId);
    if (requested !== actual) {
      throw new ValidationError("The source message is not in the thread", { field: "sourceEmailId" });
    }
  }
  if (meta.mailboxItemId === null) {
    throw new ValidationError("The source message belongs to no mailbox", { field: "sourceEmailId" });
  }
  return { emailId: args.sourceEmailId, mailboxId: meta.mailboxItemId };
}

/**
 * Refuses a reply to the message `sourceEmailId` when its thread already has an open agent draft (issue gh-1941): the
 * 409 `mail_agent_draft_exists` names that draft. The read takes no lock; a draft made by a concurrent call between this
 * read and the insert is still refused, by the unique index `mail_drafts_one_unsent_agent_per_thread_uq`, with the 409
 * of the draft store that names no draft.
 */
async function refuseSecondAgentDraft(client: PoolClient, sourceEmailId: string): Promise<void> {
  const meta = await getMailMessageMetaByItemId(client, sourceEmailId);
  const threadId = meta?.threadId ? await resolveMergedThreadId(client, meta.threadId) : null;
  if (threadId === null) return;
  const open = await findOpenAgentDraftOfThread(client, threadId);
  if (open !== null) throw new OpenAgentDraftConflictError(open.emailItemId);
}

/**
 * `mail.draft.create { mode, threadId?, sourceEmailId?, mailboxId?, to?, cc?, bcc?, subject?, body }` (issue gh-1927):
 * creates the draft as an agent in one transaction, with the run's id and Semp thread recorded on its row, and answers
 * the draft as `GET /api/mail/drafts/:id` shows it. Nothing else is written, and the draft is not sent.
 *
 * - `new` needs `mailboxId` (an unknown mailbox is a 404) and sends from the mailbox's primary address, its first one. It
 *   takes the recipients, the subject and the body as given and has no thread unless `threadId` names one. It takes no
 *   `sourceEmailId` (a 400).
 * - `reply`, `replyAll` and `forward` are prefilled from the source message (`createPrefilledEmailDraft`, issue gh-1899):
 *   the mailbox is the one the source is in, the sending address the one it was delivered to, and the recipients and
 *   the subject are computed unless the call gives `to`, `cc`, `bcc` or `subject`, which then replace them. A forward
 *   copies the source's attachments under the limit of the mailbox's provider and, for a mailbox without one, under
 *   `MAX_FILE_SIZE_MB` (`readMaxFileSizeBytes`, the limit of the HTTP forward), so one over it is refused with the 413
 *   `mail_attachment_too_large` and writes nothing; `options.maxFileSizeBytes` replaces that setting in a test. A
 *   second unsent draft of an agent for one thread is refused: a `reply` or `replyAll` for a thread that has an open
 *   agent draft with the 409 `mail_agent_draft_exists`, whose answer carries that draft's id as `draftId` (issue
 *   gh-1941), and any other mode with the 409 of the draft store.
 *
 * A refusal writes nothing.
 */
export function createMailDraftCreateTool(pool: Pool, options: { maxFileSizeBytes?: number } = {}): MailAgentTool {
  const queueAffinity = createActionQueueAffinity();
  return async function mailDraftCreate(runId, rawArgs) {
    const args = mailDraftCreateArgsSchema.safeParse(rawArgs);
    if (!args.success) return refusal(new ValidationError("Invalid arguments"));
    const { mode, threadId, sourceEmailId, mailboxId, to, cc, bcc, subject, body } = args.data;
    return answering(() =>
      withTransaction(pool, async (client) => {
        const run = await runContext(client, runId);
        const context: MailDraftWriteContext = {
          writer: run.writer,
          actingUserId: run.actorUserId,
          queueAffinity,
          ...(run.conversationId === undefined ? {} : { conversationId: run.conversationId }),
        };
        let draft: EmailDraftView;
        if (mode === "new") {
          if (sourceEmailId !== undefined) {
            throw new ValidationError("A new draft has no source message", { field: "sourceEmailId" });
          }
          if (mailboxId === undefined) throw new ValidationError("A new draft needs a mailbox", { field: "mailboxId" });
          const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
          const mailbox = await getItemById(client, mailboxesDatabaseId, mailboxId);
          if (!mailbox || mailbox.deletedAt) throw new NotFoundError("Mailbox not found");
          draft = await createEmailDraftInMailbox(
            client,
            {
              mailboxItemId: mailboxId,
              from: sendingAddress(parseAddressListProperty(mailbox.properties.addresses), null),
              to: to ?? [],
              cc: cc ?? [],
              bcc: bcc ?? [],
              subject: subject ?? "",
              body,
              threadId: threadId ?? null,
              mode,
              sourceEmailItemId: null,
            },
            context,
          );
        } else {
          const source = await findSourceMessage(client, { threadId, sourceEmailId });
          if (mode === "reply" || mode === "replyAll") await refuseSecondAgentDraft(client, source.emailId);
          const { rows } = await client.query<{ locale: string }>("SELECT locale FROM users WHERE id = $1", [
            run.actorUserId,
          ]);
          const { locale } = requireSingleRow(rows, "user of the run");
          draft = await createPrefilledEmailDraft(
            client,
            {
              mailboxItemId: source.mailboxId,
              sourceEmailItemId: source.emailId,
              mode,
              locale,
              body,
              ...(mode === "forward" ? { uploadLimitBytes: options.maxFileSizeBytes ?? readMaxFileSizeBytes() } : {}),
              overrides: { to, cc, bcc, subject },
            },
            context,
          );
        }
        return { error: false, result: JSON.stringify(draft) };
      }),
    );
  };
}

/**
 * `mail.draft.update { draftId, body, subject? }` (issue gh-1927): replaces the body, and the subject when it is given, of
 * an open draft and records the agent as the draft's last editor. It answers the draft as the draft routes show it. The
 * draft is locked before its version is read, so the update is made against the state it saw. A draft that does not
 * exist, one that is discarded and another tenant's are the same 404; a sent draft is a 409
 * `mail_draft_already_sent` and a message without a draft row a 409 `mail_draft_not_editable`. Recipients, sender,
 * mailbox and thread stay as they are.
 *
 * A run that was started by a heartbeat, directly or through a delegation, never replaces a draft whose last editor is
 * the user (issue gh-1941): the 409 `mail_draft_edited_by_user` names the draft and nothing is written. The check reads
 * the draft row after the draft's locks are taken, so an edit that the user saved after the run started is seen; a run a
 * person asked for (a chat turn that names the draft, an MCP client) may rewrite it, because the person asked.
 *
 * When the run belongs to a Semp thread (it was started from a chat turn), the new body is published to the run's
 * watchers as an ephemeral `agent:delta` frame `{ kind: "mailDraftBody", draftId, body }` (issue gh-1948,
 * `MailDraftBodyDelta` in `@semprec/realtime`), once the refusals that are known beforehand have passed (arguments,
 * including a blank subject, and a draft that is open) and before the update is written, so it precedes the commit of
 * the durable change. Those refusals publish nothing. The write's access check cannot refuse here: Emails is a system
 * database that is not sensitive, which every project may write whatever the grants say. A failure inside the write
 * itself (a statement error, say) rolls the update back after the frame was sent and leaves an unstored frame, which the
 * run's end clears; the frame is best effort, the durable change is the draft update and its invalidation. A run
 * without a thread, such as an MCP run, publishes none.
 */
export function createMailDraftUpdateTool(pool: Pool): MailAgentTool {
  const queueAffinity = createActionQueueAffinity();
  return async function mailDraftUpdate(runId, rawArgs) {
    const args = mailDraftUpdateArgsSchema.safeParse(rawArgs);
    if (!args.success) return refusal(new ValidationError("Invalid arguments"));
    return answering(() =>
      withTransaction(pool, async (client) => {
        const run = await runContext(client, runId);
        const { emailsDatabaseId } = await resolveMailModuleIds(client);
        const { item, draft: locked } = await lockUnsentDraft(client, emailsDatabaseId, args.data.draftId);
        // The gate of the heartbeat that drafts a reply (`answerExpectedFilter.ts`) checks the draft when the run starts;
        // the run lasts a whole agent session, so the check that holds is this one, made under the draft's locks.
        if (locked.lastEditedBy === "user" && (await startedByHeartbeat(client, run.run))) {
          throw new DraftEditedByUserError(args.data.draftId);
        }
        if (run.conversationId !== undefined) {
          await notifyAgentRunDelta({
            agentRunId: runId,
            delta: { kind: "mailDraftBody", draftId: item.id, body: args.data.body },
          });
        }
        const draft = await updateEmailDraft(
          client,
          {
            draftItemId: args.data.draftId,
            ifVersion: item.updatedAt,
            body: args.data.body,
            ...(args.data.subject === undefined ? {} : { subject: args.data.subject }),
          },
          { writer: run.writer, actingUserId: run.actorUserId, queueAffinity },
        );
        return { error: false, result: JSON.stringify(draft) };
      }),
    );
  };
}

/**
 * What a deferred module tool call answers the model (issue #1791, `moduleToolPendingApprovalText` in
 * `semprec-agents/src/agentSessionComposition.ts`): the same sentence, so the model reads one wording for every call
 * that waits for a person.
 */
function pendingApprovalText(toolName: string, approvalRequestId: string): string {
  return `Tool '${toolName}' requires human approval before it can run. Approval request ${approvalRequestId} has been created and is awaiting a decision; this call has not been executed.`;
}

/**
 * `mail.draft.send { draftId }` (issue gh-1949): asks for the send of a saved draft and never sends it. The run is the
 * agent actor of the send flow of issue gh-1913 (`requestMailSendApproval`, the request `sendDraftEmail` creates for
 * an `ai_agent` actor), whatever permission the run's project holds: in v1 no permission lets an agent send without
 * approval. The answer is the sentence of a deferred tool naming the pending approval request, risk class `outbound`,
 * that holds the draft's hash, and the request's id as `approvalRequestId`, the structured half of the shape of a
 * deferred tool (the session stores it in the tool result's details, so the run's step is an approval step). The mail
 * leaves only when its owner approves that request (the executor of
 * `mailSendApprovalExecution.ts` sends it, as the user). This handler holds no mail transport, so it cannot send.
 *
 * A draft that already has a pending request answers with that request and creates no second one. A draft that is
 * unknown, discarded or another tenant's is the same 404; a sent draft is a 409 `mail_draft_already_sent`, a message
 * without a draft row a 409 `mail_draft_not_editable`, a draft without a recipient a 400, and a run that is unknown (404)
 * or has no project (403) is refused as by the other mail tools. A refusal writes nothing.
 */
export function createMailDraftSendTool(pool: Pool): MailAgentTool {
  return async function mailDraftSend(runId, rawArgs) {
    const args = mailDraftSendArgsSchema.safeParse(rawArgs);
    if (!args.success) return refusal(new ValidationError("Invalid arguments"));
    return answering(async () => {
      await withTransaction(pool, (client) => runContext(client, runId));
      const request = await requestMailSendApproval(pool, args.data.draftId, { type: "ai_agent", agentRunId: runId });
      return {
        error: false,
        result: pendingApprovalText(request.toolName, request.id),
        approvalRequestId: request.id,
      };
    });
  };
}
