package cz.alldots.app.core

/**
 * Why the server refused a draft, a send or a thread action, for a reason the person can understand: a folder the
 * mailbox's server does not have, an account that must sign in again or has Mail switched off, a recipient or login
 * the mail server refused, a draft that is no longer the person's to change, or a thread the action does not fit.
 */
enum class MailRefusal {
    DRAFTS_FOLDER_MISSING,
    SENT_FOLDER_MISSING,
    ARCHIVE_FOLDER_MISSING,
    TRASH_FOLDER_MISSING,
    INBOX_FOLDER_MISSING,
    REAUTHORIZATION_REQUIRED,
    MAIL_DISABLED,
    RECIPIENT_REJECTED,
    LOGIN_REJECTED,
    SERVER_UNREACHABLE,
    ATTACHMENT_TOO_LARGE,
    DRAFT_ALREADY_SENT,
    DRAFT_NOT_EDITABLE,
    NO_RECEIVED_MESSAGE,
    MOVE_SOURCE_UNVERIFIED,
    ALREADY_TRASHED,
    NOT_ARCHIVED_OR_TRASHED,
}
