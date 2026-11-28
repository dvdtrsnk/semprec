package cz.alldots.app.presentation

import cz.alldots.app.core.FailureKind

enum class SempThreadPhase { LOADING, READY, ERROR }

/** Which thread a chat screen opens on: the latest chat, a new one, a given thread, or the thread of an Inbox item. */
enum class SempThreadStart { LATEST, NEW, EXISTING, ITEM }

/** What kind of thread the screen shows. */
enum class SempThreadType { CHAT, ITEM, TICK }

enum class SempEntryRole { USER, ASSISTANT, SYSTEM }

/** A message of the person that has not reached the server ([SENDING]) or did not ([FAILED]); sent ones have none. */
enum class SempDelivery { SENDING, FAILED }

/**
 * Where a reply is. [THINKING] is a reply waiting for its turn and [WORKING] one in the making; the server does not
 * stream, so the chat asks again until the reply is [DONE] or [FAILED].
 */
enum class SempReplyPhase { THINKING, WORKING, DONE, FAILED }

/** An object a message was about. [label] is `null` when the server no longer knows it. */
data class SempChip(val kind: SempTargetKind, val label: String?, val exists: Boolean)

enum class SempChangeType { CREATED, UPDATED, DELETED, RESTORED, REVISED }

/** An item a reply changed; [label] is its name now, `null` when it has none. */
data class SempChangeCard(
    val itemId: String,
    val databaseId: String,
    val databaseKey: String?,
    val kind: SempTargetKind,
    val change: SempChangeType,
    val label: String?,
    val active: Boolean,
)

enum class SempStepsPhase { NONE, LOADING, READY, ERROR }

enum class SempLineState { RUNNING, OK, ERROR, WAITING_APPROVAL }

/** One line of an opened run; [title] and [summary] are the server's text in the person's language. */
data class SempStepLine(
    val id: String,
    val state: SempLineState,
    val title: String,
    val summary: String?,
    val durationMs: Long?,
)

enum class SempRunChipState { OK, WAITING_APPROVAL, FAILED }

/**
 * The summary of what Semp did for one reply, which opens into its steps. [durationMs] adds up the steps; [stepCount]
 * counts them.
 */
data class SempRunChip(
    val runId: String,
    val messageId: String,
    val stepCount: Int,
    val durationMs: Long,
    val state: SempRunChipState,
    val expanded: Boolean,
    val stepsPhase: SempStepsPhase,
    val steps: List<SempStepLine>,
)

/** Why a reply failed: the server's closed [code] and its text in the person's language. */
data class SempReplyFailure(val code: String, val message: String?)

/**
 * One line of the conversation. [text] of an assistant message is Markdown. [systemKey] is the key of a system
 * message, which the app writes in its own words.
 */
data class SempEntry(
    val id: String,
    val role: SempEntryRole,
    val text: String?,
    val systemKey: String?,
    val chips: List<SempChip>,
    val delivery: SempDelivery?,
    val deliveryFailure: FailureKind?,
    val replyPhase: SempReplyPhase,
    val run: SempRunChip?,
    val changes: List<SempChangeCard>,
    val approvals: List<SempApprovalItem>,
    val failure: SempReplyFailure?,
    val incomplete: Boolean,
    val canRegenerate: Boolean,
)

/** The automatic task behind a tick thread. */
data class SempTickInfo(
    val name: String,
    val projectName: String?,
    val enabled: Boolean,
    val canTrigger: Boolean,
    val running: Boolean,
    val triggerFailed: Boolean,
)

/** The object an Inbox item thread is about, as the thing that opened it named it. */
data class SempSubject(val title: String?, val meta: String?)

/** The notice of a problem with Semp that the chat shows above the conversation until it is closed. */
data class SempNotice(val id: String, val title: String, val text: String)

data class SempThreadState(
    val phase: SempThreadPhase = SempThreadPhase.LOADING,
    val failure: FailureKind? = null,
    val type: SempThreadType = SempThreadType.CHAT,
    val threadId: String? = null,
    val title: String? = null,
    val subject: SempSubject? = null,
    val tick: SempTickInfo? = null,
    val entries: List<SempEntry> = emptyList(),
    val hasOlder: Boolean = false,
    val loadingOlder: Boolean = false,
    val attachments: List<SempAttachment> = emptyList(),
    val canAttach: Boolean = false,
    val sending: Boolean = false,
    val notice: SempNotice? = null,
    val actionFailed: Boolean = false,
    val actionFailure: FailureKind? = null,
)

sealed interface SempThreadAction {
    data object Retry : SempThreadAction

    /** Reads the thread again, for a screen that comes back to the front. */
    data object Refresh : SempThreadAction

    data class Send(val text: String) : SempThreadAction

    /** Sends a message that did not reach the server again ([retry]), or drops it. */
    data class ResolveUnsent(val id: String, val retry: Boolean) : SempThreadAction

    /** Asks the server for the reply [messageId] again: a failed reply is retried, an answer is written again. */
    data class AskAgain(val messageId: String, val regenerate: Boolean) : SempThreadAction

    data class ToggleRun(val messageId: String) : SempThreadAction

    data class Decide(val approvalId: String, val approve: Boolean) : SempThreadAction

    data object LoadOlder : SempThreadAction

    data object RunAgain : SempThreadAction

    /** The person puts something away: the notice of a problem, a failure that was shown, or a staged object. */
    sealed interface Dismiss : SempThreadAction {
        data object Notice : Dismiss

        data object Failure : Dismiss

        data class Attachment(val key: String) : Dismiss
    }

    /** The person opens something that the app shows; the answer is an effect. */
    sealed interface Open : SempThreadAction {
        data class Run(val runId: String, val messageId: String?) : Open

        data class Change(val itemId: String, val databaseKey: String?) : Open

        data object Approvals : Open

        data object Status : Open

        data object History : Open

        data object NewChat : Open
    }
}

sealed interface SempThreadEffect {
    data class OpenRun(val runId: String, val messageId: String?) : SempThreadEffect

    data class OpenItem(val itemId: String, val databaseKey: String?) : SempThreadEffect

    data object OpenApprovals : SempThreadEffect

    data object OpenStatus : SempThreadEffect

    data object OpenHistory : SempThreadEffect

    data object OpenNewChat : SempThreadEffect
}
