package cz.semprec.app.domain

/** What a Semp thread is: a chat of the person, the thread of one Inbox item, or the thread of an automatic task. */
enum class SempThreadKind { CHAT, ITEM, TICK }

/** The last message of a thread as the history shows it: text, or the key of a system message without text. */
data class SempPreview(val text: String?, val systemKey: String?)

/** One row of the chat history. [title] is `null` for a chat the server has not titled yet. */
data class SempThreadRow(
    val id: String,
    val kind: SempThreadKind,
    val title: String?,
    val preview: SempPreview?,
    val lastActivityAt: String,
    val hasPendingApproval: Boolean,
    val projectName: String?,
    val subjectInboxItemId: String?,
)

data class SempThreadsPage(val rows: List<SempThreadRow>, val nextCursor: String?)

/** What the history asks for: [kinds] to list, a [search] text, and where the list continues. */
data class SempThreadsQuery(
    val kinds: Set<SempThreadKind>,
    val search: String? = null,
    val cursor: String? = null,
    val limit: Int = SEMP_THREADS_PAGE_SIZE,
    val subjectInboxItemId: String? = null,
)

const val SEMP_THREADS_PAGE_SIZE = 50

/** The automation behind a tick thread. [canTrigger] is `true` when it is enabled and not event-triggered. */
data class SempTickHeader(
    val heartbeatId: String,
    val name: String,
    val enabled: Boolean,
    val projectItemId: String,
    val projectName: String?,
    val canTrigger: Boolean,
)

/** One thread. [tick] and [activeRunId] are set for a tick thread only. */
data class SempThread(
    val id: String,
    val kind: SempThreadKind,
    val title: String?,
    val subjectInboxItemId: String?,
    val tick: SempTickHeader?,
    val activeRunId: String?,
)

enum class SempRole { USER, ASSISTANT, SYSTEM }

/** [QUEUED] and [RUNNING] are replies still being made; [ERROR] one whose turn failed; [DONE] everything else. */
enum class SempMessageStatus { QUEUED, RUNNING, DONE, ERROR }

/** What a message refers to. [OTHER] is a kind this app does not open. */
enum class SempRefKind {
    ITEM,
    BLOCK,
    TRANSCRIPT_SEGMENT,
    MAIL_ATTACHMENT,
    MAIL_THREAD,
    AGENT_RUN,
    APPROVAL_REQUEST,
    OTHER,
}

/**
 * A reference stored with a user message: its [kind], the id it opens by, its label as captured, and whether it
 * still exists.
 */
data class SempContextRef(
    val kind: SempRefKind,
    val id: String?,
    val databaseId: String?,
    val databaseKey: String?,
    val label: String?,
    val exists: Boolean,
)

enum class SempStepStatus { OK, WAIT, ERROR }

/** The live state of the approval request a step asked for; [conflictKey] says why an approved request did not run. */
data class SempStepApproval(val status: String, val executionStatus: String, val conflictKey: String?)

/** One step of a reply; its wording is read from the run's steps, which the server writes in the person's language. */
data class SempStep(
    val status: SempStepStatus,
    val durationMs: Long,
    val approvalRequestId: String?,
    val approval: SempStepApproval?,
)

enum class SempChangeKind { CREATED, UPDATED, DELETED, RESTORED, REVISED }

/** An item a reply changed; [label] is the item's current name, `null` when it has none or is purged. */
data class SempChange(
    val itemId: String,
    val databaseId: String,
    val kind: SempChangeKind,
    val label: String?,
    val databaseKey: String?,
    val active: Boolean,
)

/** Why a reply is incomplete or failed, as the server's closed codes; [message] is the server's text. */
data class SempReplyError(val code: String, val message: String)

data class SempMessage(
    val id: String,
    val role: SempRole,
    val text: String?,
    val systemKey: String?,
    val context: List<SempContextRef>,
    val replyToMessageId: String?,
    val attempt: Int,
    val replaced: Boolean,
    val agentRunId: String?,
    val status: SempMessageStatus,
    val createdAt: String,
    val changes: List<SempChange>,
    val steps: List<SempStep>,
    val incomplete: Boolean,
    val error: SempReplyError?,
)

/** A page of messages, newest first; [nextCursor] continues towards older messages. */
data class SempMessagesPage(val rows: List<SempMessage>, val nextCursor: String?)

/** An object a message is about, named the way the server's `context` takes it. */
data class SempRefInput(val kind: SempRefKind, val id: String, val databaseId: String?)

/**
 * A message to send: into [threadId], or into a new chat; with [subjectInboxItemId] into the thread of that Inbox
 * item.
 */
data class SempSendRequest(
    val threadId: String?,
    val subjectInboxItemId: String?,
    val text: String,
    val context: List<SempRefInput>,
)

data class SempSendReceipt(val threadId: String, val messageId: String, val assistantMessageId: String)
