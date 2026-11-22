package cz.semprec.app.data

import cz.semprec.app.core.MailContentUnavailable
import cz.semprec.app.domain.MailContentOutcome
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.map
import kotlinx.serialization.SerializationException

private const val CONTENT_UNAVAILABLE_CODE = "mail_content_unavailable"
private const val TOO_MANY_REQUESTS_STATUS = 429

/** The `details.reason` values of `mail_content_unavailable`, as the server names them. */
private val CONTENT_UNAVAILABLE_REASONS = mapOf(
    "reauthorizationRequired" to MailContentUnavailable.REAUTHORIZATION_REQUIRED,
    "providerUnreachable" to MailContentUnavailable.PROVIDER_UNREACHABLE,
    "messageNotFound" to MailContentUnavailable.MESSAGE_NOT_FOUND,
    "mailboxUnavailable" to MailContentUnavailable.MAILBOX_UNAVAILABLE,
    "attachmentTooLarge" to MailContentUnavailable.ATTACHMENT_TOO_LARGE,
)

/**
 * The answer of a route that may ask the mail provider: a success decoded by [decodeSuccess] is
 * [MailContentOutcome.Done], a `409 mail_content_unavailable` with a known reason and a `429` (the per-person throttle
 * of provider fetches) are [MailContentOutcome.Unavailable], and any other failure (a `404` among them) stays its
 * [cz.semprec.app.core.FailureKind].
 */
internal fun <T> ApiResponse.mailContentOutcome(
    decodeSuccess: ApiResponse.() -> RepositoryResult<T>,
): RepositoryResult<MailContentOutcome<T>> {
    val failure = this as? ApiResponse.Failure ?: return decodeSuccess().map { MailContentOutcome.Done(it) }
    val reason = if (failure.status == TOO_MANY_REQUESTS_STATUS) {
        MailContentUnavailable.RATE_LIMITED
    } else {
        failure.contentUnavailableReason()
    }
    return if (reason == null) {
        RepositoryResult.Failure(failure.kind)
    } else {
        RepositoryResult.Content(MailContentOutcome.Unavailable(reason))
    }
}

/** The reason of a `mail_content_unavailable` answer; `null` for another answer or a reason this app does not know. */
private fun ApiResponse.Failure.contentUnavailableReason(): MailContentUnavailable? {
    val text = body ?: return null
    val error = try {
        ApiJson.decodeFromString(MailContentErrorDto.serializer(), text).error
    } catch (_: SerializationException) {
        null
    } catch (_: IllegalArgumentException) {
        null
    }
    return error?.takeIf { it.code == CONTENT_UNAVAILABLE_CODE }?.details?.reason?.let(CONTENT_UNAVAILABLE_REASONS::get)
}
