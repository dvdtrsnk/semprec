package cz.alldots.app.presentation

import cz.alldots.app.domain.MailConnectOutcome
import cz.alldots.app.domain.MailConnectRefusal
import cz.alldots.app.domain.MailboxRepository
import cz.alldots.app.domain.RepositoryResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/**
 * The password sign-in of one screen, one at a time: [open] shows it, [handle] sends the password or closes it. The
 * sign-in lives in the screen's state, which [read] and [write] reach; a refused login stays open with its reason, an
 * accepted one closes and calls [signedIn]. Everything runs in [scope], on the main thread.
 */
internal class PasswordSignInFlow(
    private val scope: CoroutineScope,
    private val mailboxes: MailboxRepository,
    private val read: () -> InternetPasswordSignIn?,
    private val write: (InternetPasswordSignIn?) -> Unit,
    private val signedIn: () -> Unit,
) {
    /** Opens the sign-in of [accountId] unless one is open. */
    fun open(accountId: String, address: String?, provider: String?) {
        if (read() != null) return
        write(InternetPasswordSignIn(accountId = accountId, address = address, icloud = provider == ICLOUD_PROVIDER))
    }

    fun handle(step: InternetPasswordSignInStep) {
        val current = read() ?: return
        when (step) {
            InternetPasswordSignInStep.Cancel -> if (!current.submitting) write(null)
            is InternetPasswordSignInStep.Submit -> submit(current, step)
        }
    }

    private fun submit(current: InternetPasswordSignIn, step: InternetPasswordSignInStep.Submit) {
        if (current.submitting) return
        if (step.password.isEmpty()) {
            write(current.copy(failure = InternetConnectFailure.INVALID_INPUT))
            return
        }
        write(current.copy(submitting = true, failure = null))
        val username = step.username.trim().takeIf { it.isNotEmpty() }
        scope.launch {
            val result = mailAttempt { mailboxes.updatePassword(current.accountId, step.password, username) }
            ensureActive()
            val failure = when (val outcome = (result as? RepositoryResult.Content)?.value) {
                is MailConnectOutcome.Connected -> null
                is MailConnectOutcome.Refused -> outcome.reason.toFailure()
                null -> (result as? RepositoryResult.Failure).toProblem()
            }
            // The screen may have dropped the sign-in meanwhile (a new load); a refusal then reopens nothing.
            val shown = read()?.accountId == current.accountId
            when {
                failure == null -> {
                    if (shown) write(null)
                    signedIn()
                }
                shown -> write(current.copy(failure = failure))
            }
        }
    }
}

/** The stored provider of an iCloud account. */
private const val ICLOUD_PROVIDER = "icloud"

/** What the screens say about a login the server refused, by password or in the browser. */
internal fun MailConnectRefusal.toFailure(): InternetConnectFailure = when (this) {
    MailConnectRefusal.WRONG_CREDENTIALS -> InternetConnectFailure.WRONG_CREDENTIALS
    MailConnectRefusal.APP_PASSWORD_REQUIRED -> InternetConnectFailure.APP_PASSWORD_REQUIRED
    MailConnectRefusal.SERVER_UNREACHABLE -> InternetConnectFailure.SERVER_UNREACHABLE
    MailConnectRefusal.TLS_FAILED -> InternetConnectFailure.TLS_FAILED
    MailConnectRefusal.CALDAV_REFUSED -> InternetConnectFailure.CALDAV_REFUSED
    MailConnectRefusal.CALDAV_UNREACHABLE -> InternetConnectFailure.CALDAV_UNREACHABLE
    MailConnectRefusal.ALREADY_CONNECTED -> InternetConnectFailure.ALREADY_CONNECTED
    MailConnectRefusal.RATE_LIMITED -> InternetConnectFailure.RATE_LIMITED
    MailConnectRefusal.WRONG_ACCOUNT -> InternetConnectFailure.WRONG_ACCOUNT
    MailConnectRefusal.MAIL_CONSENT_MISSING -> InternetConnectFailure.MAIL_CONSENT_MISSING
}
