package cz.alldots.app.presentation

import cz.alldots.app.core.FailureKind
import cz.alldots.app.core.MailContentUnavailable
import cz.alldots.app.core.MailRefusal
import cz.alldots.app.domain.MailContentOutcome
import cz.alldots.app.domain.MailOutcome
import cz.alldots.app.domain.RepositoryResult

/** A mail call's answer as a screen keeps it: the value, or the failure with the refusal behind it. */
internal sealed interface MailWrite<out T> {
    data class Done<out T>(val value: T) : MailWrite<T>

    /**
     * [failure] is `null` for an exception nobody expects; [refusal] names the reason the server gave, and then
     * [failure] is [FailureKind.REJECTED].
     */
    data class Failed(val failure: FailureKind?, val refusal: MailRefusal? = null) : MailWrite<Nothing>
}

/** The answer of [mailAttempt] as a [MailWrite]; `null` (an unexpected exception) fails without a kind. */
internal fun <T> RepositoryResult<T>?.toWrite(): MailWrite<T> = when (this) {
    is RepositoryResult.Content -> MailWrite.Done(value)
    is RepositoryResult.Failure -> MailWrite.Failed(kind)
    null -> MailWrite.Failed(null)
}

/** Runs a mail write the server may refuse for a known reason, through [mailAttempt]. */
internal suspend fun <T> mailWrite(call: suspend () -> RepositoryResult<MailOutcome<T>>): MailWrite<T> =
    when (val written = mailAttempt(call).toWrite()) {
        is MailWrite.Done -> when (val outcome = written.value) {
            is MailOutcome.Done -> MailWrite.Done(outcome.value)
            is MailOutcome.Refused -> MailWrite.Failed(FailureKind.REJECTED, outcome.refusal)
        }
        is MailWrite.Failed -> written
    }

/** A mail read or save that may ask the provider, as a screen keeps it: the value, or why it is not there. */
internal sealed interface MailFetch<out T> {
    data class Done<out T>(val value: T) : MailFetch<T>

    /**
     * [failure] is `null` for an exception nobody expects; [unavailable] names why the server could not reach the
     * provider's copy, and then [failure] is [FailureKind.UNAVAILABLE].
     */
    data class Failed(val failure: FailureKind?, val unavailable: MailContentUnavailable? = null) : MailFetch<Nothing>
}

/** Runs a mail read or save that may ask the provider, through [mailAttempt]. */
internal suspend fun <T> mailFetch(call: suspend () -> RepositoryResult<MailContentOutcome<T>>): MailFetch<T> =
    when (val answer = mailAttempt(call)) {
        is RepositoryResult.Content -> when (val outcome = answer.value) {
            is MailContentOutcome.Done -> MailFetch.Done(outcome.value)
            is MailContentOutcome.Unavailable -> MailFetch.Failed(FailureKind.UNAVAILABLE, outcome.reason)
        }
        is RepositoryResult.Failure -> MailFetch.Failed(answer.kind)
        null -> MailFetch.Failed(null)
    }
