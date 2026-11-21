package cz.semprec.app.domain

import cz.semprec.app.core.MailRefusal

/** How a mail write the server may refuse ended: [Done] with its answer, or [Refused] for a known [MailRefusal]. */
sealed interface MailOutcome<out T> {
    data class Done<out T>(val value: T) : MailOutcome<T>

    data class Refused(val refusal: MailRefusal) : MailOutcome<Nothing>
}
