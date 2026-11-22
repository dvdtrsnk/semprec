package cz.semprec.app.core

/**
 * Why the server could not fetch a message's content or an attachment's bytes from the mail provider: the account must
 * sign in again, the provider could not be reached, the provider no longer holds the message, the account is removed
 * or has Mail switched off, the attachment is too large, or the person asked the provider too often in a short time.
 */
enum class MailContentUnavailable {
    REAUTHORIZATION_REQUIRED,
    PROVIDER_UNREACHABLE,
    MESSAGE_NOT_FOUND,
    MAILBOX_UNAVAILABLE,
    ATTACHMENT_TOO_LARGE,
    RATE_LIMITED,
}
