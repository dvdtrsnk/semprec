package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.MailRefusal
import cz.semprec.app.domain.MailOutcome
import cz.semprec.app.domain.RepositoryResult

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
