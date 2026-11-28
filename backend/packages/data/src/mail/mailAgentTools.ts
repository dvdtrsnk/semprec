// Mail module agent tools. Drafting tools never send, so they need no approval; `mail.draft.send`
// for a run only files a send approval request. Run, project and user always come from the stored
// run, never from arguments. Over `/mcp` a human session runs the `...UserTool` variants as its
// user. See docs/architecture/domain-mail-and-inbox.md#agent-sends-and-mcp-mail-tools.
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
import { requireSendAdapters, sendMailDraft, type MailDraftSendRouteDependencies } from "./mailDraftSend.js";
import { findOpenAgentDraftOfThread, MAIL_DRAFT_MODES } from "./mailDraftsStore.js";
import { getMailMessageMetaByItemId, resolveMergedThreadId } from "./mailMessageMetaStore.js";
import { resolveMailModuleIds } from "./mailModuleIds.js";
import { requestMailSendApproval } from "./mailSendApproval.js";
import {
  boundMailAgentRemoteSearch,
  MAIL_SEARCH_QUERY_MAX_LENGTH,
  searchMail,
  type MailSearchCredentialActor,
  type MailSearchRouteDependencies,
} from "./mailRemoteSearch.js";
import { getMailThreadDetail } from "./mailThreadDetail.js";
import { proposeThreadTask, threadTaskProposalNameSchema } from "./threadTaskProposals.js";

const MAX_MESSAGE_TEXT_LENGTH = 20_000;
/** Total across messages; the newest are served first. */
const MAX_THREAD_TEXT_LENGTH = 200_000;

export const mailThreadGetArgsSchema = z.strictObject({ threadId: z.uuid() });

/**
 * Reply modes derive mailbox and sender from the source message (`mailboxId` is ignored). In
 * prefilled modes a given `to`/`cc`/`bcc`/`subject` replaces the computed value as-is (`to: []`
 * clears, no `Re: ` added); omitted ones stay computed.
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
  // Refused here too so the refusal precedes the body frame.
  subject: draftSubject.refine((value) => value.trim() !== "").optional(),
});

export const mailDraftSendArgsSchema = z.strictObject({ draftId: z.uuid() });

/** At most this many threads per `mail.search` call. */
const MAIL_SEARCH_TOOL_MAX_LIMIT = 50;
const MAIL_SEARCH_TOOL_DEFAULT_LIMIT = 20;

/** The descriptions are what the model reads: this schema is the tool's parameters. */
export const mailSearchArgsSchema = z
  .strictObject({
    query: z
      .string()
      .min(1)
      .max(MAIL_SEARCH_QUERY_MAX_LENGTH)
      .describe(
        "Words to find, with the operators of the mail search if needed: from:<name or address>, has:attachment, " +
          "before:<YYYY-MM-DD>, after:<YYYY-MM-DD>, is:read, is:unread, is:flagged, a quoted phrase, -word to exclude.",
      ),
    mailboxId: z.uuid().optional().describe("Search only this internet account's mail."),
    limit: z
      .int()
      .min(1)
      .max(MAIL_SEARCH_TOOL_MAX_LIMIT)
      .optional()
      .describe(`How many threads to return, newest first; ${MAIL_SEARCH_TOOL_DEFAULT_LIMIT} when not given.`),
  })
  .describe(
    "Search the user's mail. Older messages are kept only as subject, addresses and a short preview, so the words " +
      "are also searched at the mail providers, which hold the whole messages. Returns the matching threads; read one " +
      "with mail.thread.get.",
  );

/** The descriptions are what the model reads: this schema is the tool's parameters. */
export const mailThreadProposeTaskArgsSchema = z
  .strictObject({
    threadId: z.uuid().describe("The id of the mail thread the task is suggested from."),
    name: threadTaskProposalNameSchema.describe(
      "A short name of the task, written from the conversation, up to 500 characters. Give no due date: the user sets it.",
    ),
  })
  .describe(
    "Suggest a task from a mail thread. Use this tool when the conversation asks the user to do something; it puts a " +
      "proposal in the user's Inbox that the user may edit, and only the user's confirmation creates the task. Do not " +
      "create tasks of a thread yourself: this tool never creates one.",
  );

export interface MailAgentToolResult {
  error: boolean;
  result: string;
  /** Set by `mail.draft.send`; makes the run timeline show the step as an approval. */
  approvalRequestId?: string;
}

export type MailAgentTool = (runId: string, args: unknown) => Promise<MailAgentToolResult>;

/** A mail tool run by a human `/mcp` session as its user, with no run. */
export type MailUserTool = (userId: string, args: unknown) => Promise<MailAgentToolResult>;

type MailToolCaller = { kind: "run"; runId: string } | { kind: "user"; userId: string };

type MailToolCore = (caller: MailToolCaller, args: unknown) => Promise<MailAgentToolResult>;

function asRunTool(core: MailToolCore): MailAgentTool {
  return (runId, args) => core({ kind: "run", runId }, args);
}

function asUserTool(core: MailToolCore): MailUserTool {
  return (userId, args) => core({ kind: "user", userId }, args);
}

/** Names the open agent draft so the agent updates it instead of making another. */
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

/** A heartbeat-started run would overwrite a draft the user edited last. */
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

function detailText(error: ChokePointError, key: "field" | "draftId"): string | undefined {
  if (typeof error.details !== "object" || error.details === null || !(key in error.details)) return undefined;
  const value: unknown = Reflect.get(error.details, key);
  return typeof value === "string" ? value : undefined;
}

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

/** Only `ChokePointError`s become error results; anything else propagates and rolls back. */
async function answering(work: () => Promise<MailAgentToolResult>): Promise<MailAgentToolResult> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof ChokePointError) return refusal(err);
    throw err;
  }
}

interface RunContext {
  /** `null` for a human `/mcp` session. */
  run: AgentRunRow | null;
  writer: MailDraftWriter;
  actorUserId: string;
  conversationId?: string;
}

/** A run without a project is a 403: capabilities are granted per project. */
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
 * A human `/mcp` session writes as an agent for its user with the external-client marker, which
 * keeps it out of sensitive databases (Emails is not one); see
 * docs/architecture/agents-approvals-and-ai.md#sensitive-databases.
 */
async function callerContext(client: PoolClient, caller: MailToolCaller): Promise<RunContext> {
  if (caller.kind === "run") return runContext(client, caller.runId);
  return {
    run: null,
    writer: { writerKind: "agent", externalClient: true, onBehalfOfUserId: caller.userId },
    actorUserId: caller.userId,
  };
}

/** A heartbeat run (or one delegated from it) is the agent's own initiative, not a person's request. */
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

/** What `mail.thread.get` says of a message whose body is with the provider only. */
const REMOTE_CONTENT_NOTE =
  "The content of this older message is not downloaded; bodyText is only its stored preview of up to 200 characters.";

/** Cuts by code points, never splitting a surrogate pair. */
function cutText(text: string, max: number): string {
  return Array.from(text).slice(0, max).join("");
}

/**
 * Read-only, in one REPEATABLE READ transaction so the answer is one consistent state. Merged-away
 * ids resolve to the absorbing thread; unknown, foreign and empty threads are the same 404.
 */
export function createMailThreadGetTool(pool: Pool): MailAgentTool {
  return asRunTool(mailThreadGet(pool));
}

export function createMailThreadGetUserTool(pool: Pool): MailUserTool {
  return asUserTool(mailThreadGet(pool));
}

function mailThreadGet(pool: Pool): MailToolCore {
  return async function mailThreadGetCore(caller, rawArgs) {
    const args = mailThreadGetArgsSchema.safeParse(rawArgs);
    if (!args.success) return refusal(new ValidationError("Invalid arguments"));
    return answering(() =>
      withTransaction(
        pool,
        async (client) => {
          await callerContext(client, caller);
          const thread = await getMailThreadDetail(client, args.data.threadId, false);
          let remaining = MAX_THREAD_TEXT_LENGTH;
          const messages = [...thread.messages].reverse().map((message) => {
            // An older message whose content was never fetched (or whose fetched copy expired) shows its preview;
            // nothing is fetched from the provider here.
            const remote = message.contentState === "remote";
            const text = remote ? (message.preview ?? "") : message.bodyText;
            const bodyText = cutText(text, Math.max(0, Math.min(MAX_MESSAGE_TEXT_LENGTH, remaining)));
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
              bodyTruncated: bodyText.length < text.length,
              ...(remote ? { contentNote: REMOTE_CONTENT_NOTE } : {}),
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

/** Provider searches one agent run may make; later calls of the run search the local index only. */
export const MAIL_SEARCH_PROVIDER_SEARCHES_PER_RUN = 5;
/** Runs whose provider searches this process remembers; the least recently searching ones are forgotten first. */
const MAX_TRACKED_RUNS = 10_000;

/**
 * Provider searches per run in this process. Module tools have no per-run budget of their own, so it lives here; a
 * restart of the process forgets the counts.
 */
const providerSearchesByRun = new Map<string, number>();

/** Counts one provider search of the run in the same synchronous step as the check; `false` once it has spent all. */
function reserveRunProviderSearch(runId: string): boolean {
  const used = providerSearchesByRun.get(runId) ?? 0;
  if (used >= MAIL_SEARCH_PROVIDER_SEARCHES_PER_RUN) return false;
  providerSearchesByRun.delete(runId);
  providerSearchesByRun.set(runId, used + 1);
  if (providerSearchesByRun.size > MAX_TRACKED_RUNS) {
    const oldest = providerSearchesByRun.keys().next();
    if (oldest.done !== true) providerSearchesByRun.delete(oldest.value);
  }
  return true;
}

function releaseRunProviderSearch(runId: string): void {
  const used = providerSearchesByRun.get(runId);
  if (used !== undefined) providerSearchesByRun.set(runId, Math.max(0, used - 1));
}

/** Whether the providers were searched, and if not, why not. */
type MailSearchToolRemote = "searched" | "notNeeded" | "unavailable" | "runBudgetSpent" | "rateLimited";

/**
 * Read-only. The local index and, for a query with words, the providers of every live account, as
 * `GET /api/mail/search` searches them; the provider part is skipped (the answer says why) in a process without
 * provider clients, once the run made `MAIL_SEARCH_PROVIDER_SEARCHES_PER_RUN` provider searches, or when the user's
 * `mailRemoteSearch` throttle refuses. An unknown, foreign or trashed `mailboxId` is the 404 of a random id.
 */
export function createMailSearchTool(pool: Pool): MailAgentTool {
  return asRunTool(mailSearch(pool, boundMailAgentRemoteSearch));
}

export function createMailSearchUserTool(pool: Pool, dependencies: MailSearchRouteDependencies): MailUserTool {
  return asUserTool(mailSearch(pool, () => dependencies));
}

function mailSearch(pool: Pool, dependenciesOf: () => MailSearchRouteDependencies | undefined): MailToolCore {
  return async function mailSearchCore(caller, rawArgs) {
    const args = mailSearchArgsSchema.safeParse(rawArgs);
    const query = args.success ? args.data.query.trim() : "";
    if (!args.success || query === "") return refusal(new ValidationError("Invalid arguments"));
    return answering(async () => {
      const context = await withTransaction(pool, (client) => callerContext(client, caller));
      const dependencies = dependenciesOf() ?? {};
      const actor: MailSearchCredentialActor =
        caller.kind === "run"
          ? { actorType: "ai_agent", actorId: caller.runId }
          : { actorType: "user", actorId: caller.userId };
      let remote: MailSearchToolRemote = "notNeeded";
      const admit = (): boolean => {
        const throttle = dependencies.throttle;
        if (dependencies.mailContent === undefined || throttle === undefined) {
          remote = "unavailable";
          return false;
        }
        if (caller.kind === "run" && !reserveRunProviderSearch(caller.runId)) {
          remote = "runBudgetSpent";
          return false;
        }
        if (!throttle.tryAcquire("mailRemoteSearch", context.actorUserId).granted) {
          if (caller.kind === "run") releaseRunProviderSearch(caller.runId);
          remote = "rateLimited";
          return false;
        }
        remote = "searched";
        return true;
      };
      const found = await searchMail(pool, dependencies, {
        q: query,
        mailboxId: args.data.mailboxId ?? null,
        limit: args.data.limit ?? MAIL_SEARCH_TOOL_DEFAULT_LIMIT,
        actor,
        admit,
      });
      return {
        error: false,
        result: JSON.stringify({
          threads: found.threads.map((thread) => ({
            threadId: thread.threadId,
            subject: thread.subject,
            lastMessageAt: thread.lastMessageAt,
            lastSender: { name: thread.lastSender.name, address: thread.lastSender.address },
            snippet: thread.preview,
          })),
          localCount: found.localCount,
          remoteSearch: remote,
          remote: found.remote,
        }),
      };
    });
  };
}

interface SourceMessage {
  emailId: string;
  mailboxId: string;
}

/**
 * Without `sourceEmailId`: the newest non-draft message not sent by the user, else the newest
 * non-draft. A given `sourceEmailId` must belong to `threadId` when both are given.
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
 * Unlocked read; a concurrent draft is still refused by the unique index
 * `mail_drafts_one_unsent_agent_per_thread_uq` (with a 409 that names no draft).
 */
async function refuseSecondAgentDraft(client: PoolClient, sourceEmailId: string): Promise<void> {
  const meta = await getMailMessageMetaByItemId(client, sourceEmailId);
  const threadId = meta?.threadId ? await resolveMergedThreadId(client, meta.threadId) : null;
  if (threadId === null) return;
  const open = await findOpenAgentDraftOfThread(client, threadId);
  if (open !== null) throw new OpenAgentDraftConflictError(open.emailItemId);
}

/**
 * Creates the draft as an agent in one transaction, recording run and Semp thread; never sends.
 * `new` sends from the mailbox's primary address. Reply modes are prefilled from the source,
 * sending from the address it was delivered to. A forward copies attachments within the
 * provider's (or `MAX_FILE_SIZE_MB`) limit, else 413. One unsent agent draft per thread.
 */
export function createMailDraftCreateTool(pool: Pool, options: { maxFileSizeBytes?: number } = {}): MailAgentTool {
  return asRunTool(mailDraftCreate(pool, options));
}

/** Written as an agent for the user with no run id and no Semp thread. */
export function createMailDraftCreateUserTool(pool: Pool): MailUserTool {
  return asUserTool(mailDraftCreate(pool, {}));
}

function mailDraftCreate(pool: Pool, options: { maxFileSizeBytes?: number }): MailToolCore {
  const queueAffinity = createActionQueueAffinity();
  return async function mailDraftCreateCore(caller, rawArgs) {
    const args = mailDraftCreateArgsSchema.safeParse(rawArgs);
    if (!args.success) return refusal(new ValidationError("Invalid arguments"));
    const { mode, threadId, sourceEmailId, mailboxId, to, cc, bcc, subject, body } = args.data;
    return answering(() =>
      withTransaction(pool, async (client) => {
        const run = await callerContext(client, caller);
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
 * Replaces body (and subject) of an open draft, locked before its version is read. A
 * heartbeat-started run never overwrites a draft the user edited last; the check runs under the
 * locks so a later user edit is seen.
 *
 * For a run in a Semp thread, the new body is published as an ephemeral `agent:delta` frame after
 * the known refusals and before the write. A later write failure leaves a stale frame that the
 * run's end clears; the frame is best effort.
 */
export function createMailDraftUpdateTool(pool: Pool): MailAgentTool {
  return asRunTool(mailDraftUpdate(pool));
}

/** Never refused as an unrequested edit: the session's user asked. */
export function createMailDraftUpdateUserTool(pool: Pool): MailUserTool {
  return asUserTool(mailDraftUpdate(pool));
}

function mailDraftUpdate(pool: Pool): MailToolCore {
  const queueAffinity = createActionQueueAffinity();
  return async function mailDraftUpdateCore(caller, rawArgs) {
    const args = mailDraftUpdateArgsSchema.safeParse(rawArgs);
    if (!args.success) return refusal(new ValidationError("Invalid arguments"));
    return answering(() =>
      withTransaction(pool, async (client) => {
        const run = await callerContext(client, caller);
        const { emailsDatabaseId } = await resolveMailModuleIds(client);
        const { item, draft: locked } = await lockUnsentDraft(client, emailsDatabaseId, args.data.draftId);
        // The heartbeat gate checks at run start; this check under the locks is the one that holds.
        if (locked.lastEditedBy === "user" && run.run !== null && (await startedByHeartbeat(client, run.run))) {
          throw new DraftEditedByUserError(args.data.draftId);
        }
        if (run.run !== null && run.conversationId !== undefined) {
          await notifyAgentRunDelta({
            agentRunId: run.run.id,
            delta: { kind: "mailDraftBody", draftId: item.id, body: args.data.body },
          });
        }
        const draft = await updateEmailDraft(
          client,
          {
            draftItemId: args.data.draftId,
            ifVersion: item.version,
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

/** Same wording as `moduleToolPendingApprovalText` in alldots-agents, so the model sees one phrasing. */
function pendingApprovalText(toolName: string, approvalRequestId: string): string {
  return `Tool '${toolName}' requires human approval before it can run. Approval request ${approvalRequestId} has been created and is awaiting a decision; this call has not been executed.`;
}

/**
 * Never sends: files (or reuses) an `outbound` approval request holding the draft's hash, whatever
 * the project's permissions. The mail leaves only when the owner approves; it is then sent as the
 * user. This handler holds no transport.
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

/**
 * Sends as the user without approval, exactly like the send route, with the route's answers and
 * refusals. Transports are read from `dependencies` at call time, so listing needs none.
 */
export function createMailDraftSendUserTool(pool: Pool, dependencies: MailDraftSendRouteDependencies): MailUserTool {
  return async function mailDraftSendAsUser(_userId, rawArgs) {
    const args = mailDraftSendArgsSchema.safeParse(rawArgs);
    if (!args.success) return refusal(new ValidationError("Invalid arguments"));
    return answering(async () => ({
      error: false,
      result: JSON.stringify(await sendMailDraft(pool, args.data.draftId, requireSendAdapters(dependencies))),
    }));
  };
}

/**
 * Writes only an Inbox proposal card and its thread edge; the task itself is created when the user
 * confirms, so no approval is needed. A same-named pending card (trimmed, case-folded) is reused.
 */
export function createMailThreadProposeTaskTool(pool: Pool): MailAgentTool {
  return async function mailThreadProposeTask(runId, rawArgs) {
    const args = mailThreadProposeTaskArgsSchema.safeParse(rawArgs);
    if (!args.success) {
      const field = args.error.issues[0]?.path[0];
      return refusal(new ValidationError("Invalid arguments", typeof field === "string" ? { field } : undefined));
    }
    return answering(() =>
      withTransaction(pool, async (client) => {
        await runContext(client, runId);
        return { error: false, result: JSON.stringify(await proposeThreadTask(client, args.data)) };
      }),
    );
  };
}
