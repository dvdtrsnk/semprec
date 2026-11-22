package cz.semprec.app.domain

import cz.semprec.app.core.MailContentUnavailable
import cz.semprec.app.core.MailRefusal

/** How a mail write the server may refuse ended: [Done] with its answer, or [Refused] for a known [MailRefusal]. */
sealed interface MailOutcome<out T> {
    data class Done<out T>(val value: T) : MailOutcome<T>

    data class Refused(val refusal: MailRefusal) : MailOutcome<Nothing>
}

/**
 * How a read or a save that may ask the mail provider ended: [Done] with its answer, or [Unavailable] for the reason the
 * server could not reach the provider's copy.
 */
sealed interface MailContentOutcome<out T> {
    data class Done<out T>(val value: T) : MailContentOutcome<T>

    data class Unavailable(val reason: MailContentUnavailable) : MailContentOutcome<Nothing>
}
