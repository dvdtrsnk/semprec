package cz.semprec.app.data

import cz.semprec.app.core.MailRefusal
import cz.semprec.app.domain.MailOutcome
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.map

/** The refusal codes of the draft, send and thread routes, as the server names them. */
private val MAIL_REFUSALS = mapOf(
    "mail_drafts_folder_missing" to MailRefusal.DRAFTS_FOLDER_MISSING,
    "mail_sent_folder_missing" to MailRefusal.SENT_FOLDER_MISSING,
    "mail_archive_folder_missing" to MailRefusal.ARCHIVE_FOLDER_MISSING,
    "mail_trash_folder_missing" to MailRefusal.TRASH_FOLDER_MISSING,
    "mail_inbox_folder_missing" to MailRefusal.INBOX_FOLDER_MISSING,
    "mail_reauthorization_required" to MailRefusal.REAUTHORIZATION_REQUIRED,
    "mail_disabled" to MailRefusal.MAIL_DISABLED,
    "mail_recipient_rejected" to MailRefusal.RECIPIENT_REJECTED,
    "mail_auth_failed" to MailRefusal.LOGIN_REJECTED,
    "mail_server_unreachable" to MailRefusal.SERVER_UNREACHABLE,
    "mail_attachment_too_large" to MailRefusal.ATTACHMENT_TOO_LARGE,
    "mail_draft_already_sent" to MailRefusal.DRAFT_ALREADY_SENT,
    "mail_draft_not_editable" to MailRefusal.DRAFT_NOT_EDITABLE,
    "mail_thread_no_received_message" to MailRefusal.NO_RECEIVED_MESSAGE,
    "mail_move_source_unverified" to MailRefusal.MOVE_SOURCE_UNVERIFIED,
    "mail_thread_already_trashed" to MailRefusal.ALREADY_TRASHED,
    "mail_thread_not_archived_or_trashed" to MailRefusal.NOT_ARCHIVED_OR_TRASHED,
)

/**
 * The answer of a mail write: a success decoded as [T] by [decodeSuccess] is [MailOutcome.Done], an error answer with
 * a known refusal code is [MailOutcome.Refused], and any other failure stays its [cz.semprec.app.core.FailureKind].
 */
internal fun <T> ApiResponse.mailOutcome(
    decodeSuccess: ApiResponse.() -> RepositoryResult<T>,
): RepositoryResult<MailOutcome<T>> {
    val refusal = (this as? ApiResponse.Failure)?.errorCode()?.let(MAIL_REFUSALS::get)
    return if (refusal == null) {
        decodeSuccess().map { MailOutcome.Done(it) }
    } else {
        RepositoryResult.Content(MailOutcome.Refused(refusal))
    }
}
