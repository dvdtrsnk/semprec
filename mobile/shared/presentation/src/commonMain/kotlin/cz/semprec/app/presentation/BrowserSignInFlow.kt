package cz.semprec.app.presentation

import cz.semprec.app.domain.OAuthOutcome
import cz.semprec.app.domain.OAuthSignIn
import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/** What a [BrowserSignInFlow] tells its screen. */
internal sealed interface BrowserSignInReport {
    /** A sign-in started; it runs until [Connected] or [Stopped]. */
    data object Started : BrowserSignInReport

    data class Connected(val accountId: String) : BrowserSignInReport

    /** It ended without an account: [failure] says why, `null` when the person closed the browser. */
    data class Stopped(val failure: InternetConnectFailure?) : BrowserSignInReport
}

/**
 * The browser sign-in of one screen, one at a time: [start] asks the server for the provider's page and has [open]
 * show it; the screen then reports how the browser ended, with [returned] or [closed]. Only the answer of the sign-in
 * that is waiting for one counts; a late or repeated one is ignored. Everything runs in [scope], on the main thread.
 */
internal class BrowserSignInFlow(
    private val scope: CoroutineScope,
    private val open: (url: String) -> Unit,
    private val finish: suspend (OAuthSignIn, callbackUrl: String) -> RepositoryResult<OAuthOutcome>,
    private val report: (BrowserSignInReport) -> Unit,
) {
    private var running = false
    private var waiting: OAuthSignIn? = null

    /** Starts a sign-in with [request] unless one is running. */
    fun start(request: suspend () -> RepositoryResult<OAuthSignIn>) {
        if (running) return
        running = true
        report(BrowserSignInReport.Started)
        scope.launch {
            val result = mailAttempt(request)
            ensureActive()
            if (result is RepositoryResult.Content) {
                waiting = result.value
                open(result.value.authorizeUrl)
            } else {
                stop((result as? RepositoryResult.Failure).toProblem())
            }
        }
    }

    /** The browser came back to the app at [callbackUrl]. */
    fun returned(callbackUrl: String) {
        val signIn = waiting ?: return
        waiting = null
        scope.launch {
            val result = mailAttempt { finish(signIn, callbackUrl) }
            ensureActive()
            when (val outcome = (result as? RepositoryResult.Content)?.value) {
                is OAuthOutcome.Connected -> {
                    running = false
                    report(BrowserSignInReport.Connected(outcome.accountId))
                }
                OAuthOutcome.Declined -> stop(InternetConnectFailure.DECLINED)
                null -> stop((result as? RepositoryResult.Failure).toProblem())
            }
        }
    }

    /** The browser closed without coming back: [failure] when it failed on its own, `null` when the person closed it. */
    fun closed(failure: InternetConnectFailure?) {
        if (waiting == null) return
        waiting = null
        stop(failure)
    }

    private fun stop(failure: InternetConnectFailure?) {
        running = false
        report(BrowserSignInReport.Stopped(failure))
    }
}
