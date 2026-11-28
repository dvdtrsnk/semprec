package cz.alldots.app.presentation

import cz.alldots.app.core.FailureKind
import cz.alldots.app.core.MailContentUnavailable
import cz.alldots.app.core.MailRefusal

enum class MailThreadPhase { LOADING, CONTENT, ERROR }

/**
 * Saving an attachment into Files: not asked for ([IDLE]), on its way ([SAVING]), done in this screen ([SAVED]) or
 * failed ([FAILED]), when it can be asked for again.
 */
enum class MailAttachmentSavePhase { IDLE, SAVING, SAVED, FAILED }

/**
 * A file attached to a message; the project it is stored under follows the thread's until someone changes it.
 * [fileItemId] is the Files item it is saved as, which opens it; without one it can be saved. [saveFailure] and
 * [saveUnavailable] say why the last save failed.
 */
data class MailAttachmentItem(
    val attachmentId: String,
    val filename: String,
    val contentType: String,
    val byteSize: Long,
    val project: MailLinkedValue,
    val fileItemId: String?,
    val savePhase: MailAttachmentSavePhase,
    val saveFailure: FailureKind?,
    val saveUnavailable: MailContentUnavailable?,
)

/**
 * Where the body of a message is: shown ([READY]), only at the mail provider and not asked for yet ([REMOTE]), being
 * fetched from it ([LOADING]) or not fetched ([FAILED]), when it can be asked for again.
 */
enum class MailBodyPhase { READY, REMOTE, LOADING, FAILED }

/**
 * One message of the thread. [bodyText] is the body while [bodyPhase] is [MailBodyPhase.READY], else empty; [preview]
 * is the short snippet the server keeps for every message. [bodyFailure] and [bodyUnavailable] say why the body could
 * not be fetched.
 */
data class MailMessageItem(
    val emailId: String,
    val fromName: String,
    val fromAddress: String,
    val own: Boolean,
    val toNames: List<String>,
    val date: String?,
    val bodyText: String,
    val preview: String?,
    val bodyPhase: MailBodyPhase,
    val bodyFailure: FailureKind?,
    val bodyUnavailable: MailContentUnavailable?,
    val attachments: List<MailAttachmentItem>,
    val expanded: Boolean,
)

/** A task made from the thread. [people] holds the names of the people of the conversation, joined by the app. */
data class MailTaskItem(
    val id: String,
    val name: String,
    val date: String?,
    val done: Boolean,
    val project: MailLinkedValue,
    val peopleNames: List<String>,
    val peopleLink: MailLinkInfo?,
)

/** The reply Semp prepared as a draft of the thread; [body] is its text, which the person may change before sending. */
data class MailSempDraft(val id: String, val body: String, val recipients: List<String>)

/**
 * One thread. [archivedOrTrashed] is `true` when every message of it sits in the archive or the trash, where the
 * toolbar offers to restore it. [sentFrom] names the mailbox a reply was sent from, until the screen is left.
 * [actionFailed] says a flag, move, task or reload did not go through. [sendRefusal] and [actionRefusal] name the
 * reason the server gave for refusing the send or the flag or move, next to [sendFailure] and [actionFailed].
 */
data class MailThreadState(
    val phase: MailThreadPhase = MailThreadPhase.LOADING,
    val failure: FailureKind? = null,
    val refreshing: Boolean = false,
    val subject: String = "",
    val senderName: String = "",
    val senderAddress: String = "",
    val senderRelationship: String? = null,
    val mailboxNames: List<String> = emptyList(),
    val messageCount: Int = 0,
    val flagged: Boolean = false,
    val company: MailLinkedValue = MailLinkedValue(null, null),
    val project: MailLinkedValue = MailLinkedValue(null, null),
    val messages: List<MailMessageItem> = emptyList(),
    val tasks: List<MailTaskItem> = emptyList(),
    val draft: MailSempDraft? = null,
    val sendPhase: MailSendPhase = MailSendPhase.IDLE,
    val sendFailure: FailureKind? = null,
    val sendRefusal: MailRefusal? = null,
    val sentFrom: String? = null,
    val archivedOrTrashed: Boolean = false,
    val canReply: Boolean = false,
    val acting: Boolean = false,
    val creatingTask: Boolean = false,
    val actionFailed: Boolean = false,
    val actionRefusal: MailRefusal? = null,
)

enum class MailThreadMove { ARCHIVE, TRASH, RESTORE }

sealed interface MailThreadTarget {
    /** Semp's draft in the editor. */
    data object Draft : MailThreadTarget

    /** A reply, reply-all or forward of the thread's last message in the editor. */
    data class Reply(val mode: MailReplyMode) : MailThreadTarget
    data class Task(val taskId: String) : MailThreadTarget

    /** The Files item a saved attachment is. */
    data class File(val fileItemId: String) : MailThreadTarget
}

sealed interface MailThreadAction {
    data object Retry : MailThreadAction
    data object Refresh : MailThreadAction
    /** Opens or closes a message; opening one whose body is only at the provider fetches it. */
    data class ToggleMessage(val emailId: String) : MailThreadAction

    /** Fetches the body of a message that is only at the provider again, after it failed. */
    data class LoadBody(val emailId: String) : MailThreadAction

    /** Saves an attachment of a message into Files. */
    data class SaveAttachment(val emailId: String, val attachmentId: String) : MailThreadAction
    data object ToggleFlag : MailThreadAction

    /** Moves the thread to the archive or the trash, or back to the inbox. */
    data class Move(val to: MailThreadMove) : MailThreadAction

    /** Sends Semp's draft with [body] as its text; a text other than the stored one is saved first. */
    data class SendDraft(val body: String) : MailThreadAction
    data object AddTask : MailThreadAction

    /** Asks the app to show [target]: the draft or a reply in the editor, or a task of the thread. */
    data class Open(val target: MailThreadTarget) : MailThreadAction
    data object DismissFailure : MailThreadAction
}

sealed interface MailThreadEffect {
    /** The thread was moved away; the screen goes back. */
    data object Close : MailThreadEffect
    data class Compose(val start: MailComposeStart) : MailThreadEffect
    data class OpenTask(val taskId: String) : MailThreadEffect

    /** Shows the Files item of a saved attachment, which previews the file and hands it to other apps. */
    data class OpenFile(val fileItemId: String) : MailThreadEffect
}
