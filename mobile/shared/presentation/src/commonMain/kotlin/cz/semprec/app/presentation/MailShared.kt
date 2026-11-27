package cz.semprec.app.presentation

import cz.semprec.app.domain.MailLink
import cz.semprec.app.domain.MailLinkBreaker
import cz.semprec.app.domain.MailLinkKind

/** The boxes of the thread list; a folder or an account narrows one of them. */
enum class MailListBox { INBOX, FLAGGED, SEMP_DRAFTS }

/** The thread list a screen starts with: everything of the person, or the threads of a project, a folder. */
data class MailListStart(
    val projectId: String? = null,
    val box: MailListBox = MailListBox.INBOX,
    val mailboxId: String? = null,
    val folderId: String? = null,
)

/** Where a link of a value comes from: taken over from [sourceTitles], taken over and since changed, or derived. */
enum class MailLinkType { INHERITED, BROKEN, DERIVED }

/** The state of a value that may follow another item; the popover that explains it names the sources. */
data class MailLinkInfo(
    val type: MailLinkType,
    val sourceTitles: List<String>,
    val brokenByAgent: Boolean,
)

/** A value of a thread, a file or a task with the link that ties it to its source, if it has one. */
data class MailLinkedValue(val text: String?, val link: MailLinkInfo?)

/** What a compose screen starts from: a blank message, the reply to a message, or a saved draft. */
sealed interface MailComposeStart {
    data object New : MailComposeStart

    /** A reply, reply-all or forward of [sourceEmailId], sent from the mailbox [mailboxId] that received it. */
    data class Reply(
        val sourceEmailId: String,
        val mailboxId: String,
        val mode: MailReplyMode,
    ) : MailComposeStart

    data class Draft(val draftId: String) : MailComposeStart
}

enum class MailReplyMode { REPLY, REPLY_ALL, FORWARD }

/** The progress of sending a message; [FAILED] keeps the draft so that sending again is possible. */
enum class MailSendPhase { IDLE, SENDING, SENT, FAILED }

internal fun MailLink?.toInfo(): MailLinkInfo? = this?.let {
    MailLinkInfo(
        type = when (it.kind) {
            MailLinkKind.INHERITED -> MailLinkType.INHERITED
            MailLinkKind.BROKEN -> MailLinkType.BROKEN
            MailLinkKind.DERIVED -> MailLinkType.DERIVED
        },
        sourceTitles = it.sourceTitles,
        brokenByAgent = it.brokenBy == MailLinkBreaker.AGENT,
    )
}
