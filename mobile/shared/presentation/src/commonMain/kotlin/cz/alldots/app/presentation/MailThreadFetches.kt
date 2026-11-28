package cz.alldots.app.presentation

import cz.alldots.app.core.FailureKind
import cz.alldots.app.core.MailContentUnavailable
import cz.alldots.app.domain.MailAttachment
import cz.alldots.app.domain.MailContentState
import cz.alldots.app.domain.MailMessage
import cz.alldots.app.domain.MailThreadDetail

/** A body the screen fetched from the provider for a message the server holds only as an index entry. */
internal sealed interface MailBodyFetch {
    data object Loading : MailBodyFetch

    data class Loaded(val bodyText: String) : MailBodyFetch

    data class Failed(val failure: FailureKind?, val unavailable: MailContentUnavailable?) : MailBodyFetch
}

/** An attachment save the screen asked for. */
internal sealed interface MailAttachmentSave {
    data object Saving : MailAttachmentSave

    data class Saved(val fileItemId: String) : MailAttachmentSave

    data class Failed(val failure: FailureKind?, val unavailable: MailContentUnavailable?) : MailAttachmentSave
}

/** What the screen fetched and saved itself, by message and by attachment id, laid over the thread the server sent. */
internal data class MailThreadFetches(
    val bodies: Map<String, MailBodyFetch> = emptyMap(),
    val saves: Map<String, MailAttachmentSave> = emptyMap(),
)

private fun MailAttachment.toItem(save: MailAttachmentSave?): MailAttachmentItem {
    val failed = save as? MailAttachmentSave.Failed
    return MailAttachmentItem(
        attachmentId = attachmentId,
        filename = filename,
        contentType = contentType,
        byteSize = byteSize,
        project = MailLinkedValue(project?.name, projectLink.toInfo()),
        fileItemId = (save as? MailAttachmentSave.Saved)?.fileItemId ?: fileItemId,
        savePhase = when (save) {
            null -> MailAttachmentSavePhase.IDLE
            MailAttachmentSave.Saving -> MailAttachmentSavePhase.SAVING
            is MailAttachmentSave.Saved -> MailAttachmentSavePhase.SAVED
            is MailAttachmentSave.Failed -> MailAttachmentSavePhase.FAILED
        },
        saveFailure = failed?.failure,
        saveUnavailable = failed?.unavailable,
    )
}

/** Whether the screen has to fetch the body of this message from the provider before it can show it. */
internal fun MailMessage.isRemote() = contentState == MailContentState.REMOTE

private fun MailMessage.toItem(expanded: Boolean, fetches: MailThreadFetches): MailMessageItem {
    val fetched = if (isRemote()) fetches.bodies[emailId] else null
    val failed = fetched as? MailBodyFetch.Failed
    val phase = if (!isRemote()) {
        MailBodyPhase.READY
    } else {
        when (fetched) {
            null -> MailBodyPhase.REMOTE
            MailBodyFetch.Loading -> MailBodyPhase.LOADING
            is MailBodyFetch.Loaded -> MailBodyPhase.READY
            is MailBodyFetch.Failed -> MailBodyPhase.FAILED
        }
    }
    return MailMessageItem(
        emailId = emailId,
        fromName = from?.label().orEmpty(),
        fromAddress = from?.address.orEmpty(),
        own = own,
        toNames = to.map { it.label() },
        date = date,
        bodyText = if (isRemote()) (fetched as? MailBodyFetch.Loaded)?.bodyText.orEmpty() else bodyText,
        preview = preview,
        bodyPhase = phase,
        bodyFailure = failed?.failure,
        bodyUnavailable = failed?.unavailable,
        attachments = attachments.map { it.toItem(fetches.saves[it.attachmentId]) },
        expanded = expanded,
    )
}

/** The messages as the screen shows them, open or closed, with what it fetched and saved laid over them. */
internal fun MailThreadDetail.messageItems(expanded: Set<String>, fetches: MailThreadFetches): List<MailMessageItem> =
    shownMessages().map { it.toItem(it.emailId in expanded, fetches) }
