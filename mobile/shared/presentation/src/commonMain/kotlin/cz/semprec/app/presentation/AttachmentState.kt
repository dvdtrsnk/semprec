package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.FailureKind.NOT_FOUND
import cz.semprec.app.domain.InboxAttachment
import cz.semprec.app.domain.OpenInboxAttachment
import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/** A file attached to an Inbox item; [name] is its file name when it has one, [mediaType] its MIME type. */
data class AttachmentState(val id: String, val name: String?, val mediaType: String?)

enum class AttachmentPreviewPhase { OPENING, OPEN, FAILED }

/**
 * The attachment [attachmentId] the person asked to see: its file is being made ready
 * ([AttachmentPreviewPhase.OPENING]), it is the local file [path] to preview ([AttachmentPreviewPhase.OPEN]), or it
 * could not be opened ([AttachmentPreviewPhase.FAILED], with [failure] when the reason is known).
 */
data class AttachmentPreviewState(
    val attachmentId: String,
    val phase: AttachmentPreviewPhase,
    val path: String? = null,
    val failure: FailureKind? = null,
)

internal fun InboxAttachment.toState() = AttachmentState(id, name, mimeType)

/**
 * Opens attachments for a screen, one at a time: opening another one supersedes the one being opened, and
 * [close] ends the preview or the failure and cancels what is still being opened. [publish] sets the screen's
 * [AttachmentPreviewState]; it runs on the main thread, in [scope].
 */
internal class AttachmentPreviews(
    private val scope: CoroutineScope,
    private val open: OpenInboxAttachment,
    private val publish: (AttachmentPreviewState?) -> Unit,
) {
    private var job: Job? = null

    /** Opens [attachment]; `null`, an attachment the screen no longer lists, fails as [FailureKind.NOT_FOUND]. */
    fun open(attachmentId: String, attachment: InboxAttachment?) {
        job?.cancel()
        if (attachment == null) {
            publish(AttachmentPreviewState(attachmentId, AttachmentPreviewPhase.FAILED, failure = NOT_FOUND))
            return
        }
        publish(AttachmentPreviewState(attachmentId, AttachmentPreviewPhase.OPENING))
        job = scope.launch {
            val result = try {
                open(attachment)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                null
            }
            ensureActive()
            publish(
                when (result) {
                    is RepositoryResult.Content ->
                        AttachmentPreviewState(attachmentId, AttachmentPreviewPhase.OPEN, path = result.value)
                    is RepositoryResult.Failure ->
                        AttachmentPreviewState(attachmentId, AttachmentPreviewPhase.FAILED, failure = result.kind)
                    null -> AttachmentPreviewState(attachmentId, AttachmentPreviewPhase.FAILED)
                },
            )
        }
    }

    fun close() {
        job?.cancel()
        publish(null)
    }
}
