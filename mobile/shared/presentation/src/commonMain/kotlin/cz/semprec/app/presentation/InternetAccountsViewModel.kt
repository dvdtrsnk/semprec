package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CalendarSyncStatus
import cz.semprec.app.domain.IndexMailHistory
import cz.semprec.app.domain.InternetAccount
import cz.semprec.app.domain.InternetAccountRepository
import cz.semprec.app.domain.InternetService
import cz.semprec.app.domain.MailConnectOutcome
import cz.semprec.app.domain.MailConnectRefusal
import cz.semprec.app.domain.MailHistoryLogin
import cz.semprec.app.domain.MailPasswordAccount
import cz.semprec.app.domain.MailPasswordProvider
import cz.semprec.app.domain.MailboxRepository
import cz.semprec.app.domain.OAuthProvider
import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch

private val ADDRESS = Regex("^[^\\s@,]+@[^\\s@,]+$")

/**
 * The internet accounts with what each of their services is doing, and the form that connects one with an address
 * and a password or through a browser sign-in. Connecting with a password is one request: the server checks the login
 * on its mail servers before it saves anything. A browser sign-in asks the server for the provider's page
 * ([InternetAccountsEffect.OpenSignIn]) and hands it what the browser returned; the server saves the account only then,
 * so a sign-in that is cancelled or declined leaves nothing behind. A connected account reloads the list. A connect
 * the server refuses names its reason; one refused because the address is already connected names the listed account
 * that holds it.
 *
 * A listed account that no longer signs in signs in again from its row: a Google or Microsoft account in a browser, an
 * iCloud or another account with its password, which the server checks before it keeps it. Either reloads the list
 * once the server accepted it. A change of the account data the server reports ([serverChanges]) reads the list again
 * unless a read is under way, so the statuses follow the server's.
 *
 * An account connected with a password then has its older mail history indexed from the device while the password
 * is still in memory ([IndexMailHistory], [InternetAccountsState.historyIndexing]), one account at a time; the
 * password is never stored and is dropped when its indexing ends or the screen is gone.
 */
class InternetAccountsViewModel internal constructor(
    private val accounts: InternetAccountRepository,
    private val mailboxes: MailboxRepository,
    indexHistory: IndexMailHistory,
    serverChanges: Flow<Unit>,
) : ScreenViewModel<InternetAccountsState, InternetAccountsAction, InternetAccountsEffect>(InternetAccountsState()) {
    private var loadJob: Job? = null

    private val history = MailHistoryIndexing(viewModelScope, indexHistory) { indexing ->
        update { it.copy(historyIndexing = indexing) }
    }

    /** Whether a password typed into the connect form is still held for history indexing. */
    internal val holdsHistoryLogins: Boolean get() = history.holdsLogins

    /** Whether the running browser sign-in signs a listed account in again rather than connecting a new one. */
    private var reauthorizing = false

    private val browser = BrowserSignInFlow(
        scope = viewModelScope,
        open = { url -> emit(InternetAccountsEffect.OpenSignIn(url)) },
        finish = accounts::finishSignIn,
        report = { report -> if (reauthorizing) reportSignInAgain(report) else reportSignIn(report) },
    )

    private val password = PasswordSignInFlow(
        scope = viewModelScope,
        mailboxes = mailboxes,
        read = { state.value.passwordSignIn },
        write = { signIn -> update { it.copy(passwordSignIn = signIn) } },
        signedIn = { load(showWait = false) },
    )

    init {
        load(showWait = true)
        reloadOnChanges(serverChanges) {
            if (loadJob?.isActive != true) load(showWait = state.value.phase != InternetAccountsPhase.CONTENT)
        }
    }

    override fun onAction(action: InternetAccountsAction) {
        if (isClosed) return
        when (action) {
            InternetAccountsAction.Retry -> load(showWait = true)
            InternetAccountsAction.Refresh -> load(showWait = state.value.phase != InternetAccountsPhase.CONTENT)
            is InternetAccountsAction.Open -> emit(InternetAccountsEffect.OpenAccount(action.accountId))
            is InternetAccountsAction.Connect -> connect(action)
            InternetAccountsAction.DismissConnectFailure ->
                update { it.copy(connectFailure = null, existingAccountId = null) }
            InternetAccountsAction.OpenExisting -> state.value.existingAccountId?.let {
                update { current -> current.copy(connectFailure = null, existingAccountId = null) }
                emit(InternetAccountsEffect.OpenAccount(it))
            }
            is InternetAccountsAction.SignIn -> signIn(action)
            is InternetAccountsAction.SignInAgain -> signInAgain(action.accountId)
            is InternetAccountsAction.PasswordSignIn -> password.handle(action.step)
            InternetAccountsAction.DismissSignInFailure -> update { it.copy(signInFailure = null) }
        }
    }

    private fun reportSignIn(report: BrowserSignInReport) {
        when (report) {
            BrowserSignInReport.Started -> update { it.copy(connecting = true, connectFailure = null) }
            is BrowserSignInReport.Connected -> {
                update { it.copy(connecting = false) }
                emit(InternetAccountsEffect.Connected)
                load(showWait = false)
            }
            is BrowserSignInReport.Stopped -> update { it.copy(connecting = false, connectFailure = report.failure) }
        }
    }

    private fun reportSignInAgain(report: BrowserSignInReport) {
        when (report) {
            BrowserSignInReport.Started -> update { it.copy(signingIn = true, signInFailure = null) }
            is BrowserSignInReport.Connected -> {
                reauthorizing = false
                update { it.copy(signingIn = false) }
                load(showWait = false)
            }
            is BrowserSignInReport.Stopped -> {
                reauthorizing = false
                update { it.copy(signingIn = false, signInFailure = report.failure) }
            }
        }
    }

    private fun signInAgain(accountId: String) {
        val account = state.value.accounts.firstOrNull { it.id == accountId }
        val busy = state.value.connecting || state.value.signingIn
        if (account == null || !account.canSignInAgain || busy) return
        if (account.provider in BROWSER_PROVIDERS) {
            reauthorizing = true
            browser.start { accounts.startReauthorization(accountId, emptySet()) }
        } else {
            password.open(accountId, account.address, account.provider)
        }
    }

    private fun load(showWait: Boolean) {
        loadJob?.cancel()
        update {
            if (showWait) {
                InternetAccountsState(connecting = it.connecting, historyIndexing = it.historyIndexing)
            } else {
                it.copy(refreshing = true)
            }
        }
        loadJob = viewModelScope.launch {
            val result = mailAttempt { accounts.accounts() }
            ensureActive()
            update { it.after(result) }
        }
    }

    private fun InternetAccountsState.after(result: RepositoryResult<List<InternetAccount>>?): InternetAccountsState =
        when (result) {
            is RepositoryResult.Content -> copy(
                phase = InternetAccountsPhase.CONTENT,
                failure = null,
                refreshing = false,
                accounts = result.value.map { it.toItem() },
            )
            is RepositoryResult.Failure -> failed(result.kind)
            null -> failed(null)
        }

    /** A failed first load is an error; a failed refresh leaves the list that is shown as it was. */
    private fun InternetAccountsState.failed(kind: FailureKind?): InternetAccountsState =
        if (phase == InternetAccountsPhase.CONTENT) {
            copy(refreshing = false)
        } else {
            copy(phase = InternetAccountsPhase.ERROR, failure = kind)
        }

    private fun signIn(step: InternetAccountsAction.SignIn) {
        when (step) {
            is InternetAccountsAction.SignIn.Start -> {
                if (state.value.connecting || state.value.signingIn) return
                val services = if (step.calendars) {
                    setOf(InternetService.MAIL, InternetService.CALENDARS)
                } else {
                    setOf(InternetService.MAIL)
                }
                browser.start { accounts.startSignIn(step.provider.toDomain(), services) }
            }
            is InternetAccountsAction.SignIn.Returned -> browser.returned(step.callbackUrl)
            InternetAccountsAction.SignIn.Cancelled -> browser.closed(failure = null)
            InternetAccountsAction.SignIn.Failed -> browser.closed(InternetConnectFailure.UNEXPECTED)
        }
    }

    private fun connect(form: InternetAccountsAction.Connect) {
        if (state.value.connecting) return
        val account = form.toAccount()
        if (account == null) {
            update { it.copy(connectFailure = InternetConnectFailure.INVALID_INPUT) }
            return
        }
        update { it.copy(connecting = true, connectFailure = null, existingAccountId = null) }
        viewModelScope.launch {
            val result = mailAttempt { mailboxes.connect(account) }
            ensureActive()
            when (val outcome = (result as? RepositoryResult.Content)?.value) {
                is MailConnectOutcome.Connected -> {
                    update { it.copy(connecting = false) }
                    emit(InternetAccountsEffect.Connected)
                    load(showWait = false)
                    MailHistoryLogin.of(account)?.let { history.start(outcome.mailboxId, it) }
                }
                is MailConnectOutcome.Refused -> update {
                    val existing = it.accounts.firstOrNull { listed ->
                        listed.address.equals(account.address, ignoreCase = true)
                    }
                    val alreadyConnected = outcome.reason == MailConnectRefusal.ALREADY_CONNECTED
                    it.copy(
                        connecting = false,
                        connectFailure = outcome.reason.toFailure(),
                        existingAccountId = existing?.id.takeIf { alreadyConnected },
                    )
                }
                null -> {
                    val problem = (result as? RepositoryResult.Failure).toProblem()
                    update { it.copy(connecting = false, connectFailure = problem) }
                }
            }
        }
    }
}

/** An address and a password are always required; Other also needs its IMAP and SMTP servers. */
private fun InternetAccountsAction.Connect.toAccount(): MailPasswordAccount? {
    val address = address.trim()
    val imap = imapHost.trim()
    val smtp = smtpHost.trim()
    val caldav = caldavUrl.trim()
    val other = provider == InternetPasswordProvider.OTHER
    val serversKnown = !other || (imap.isNotEmpty() && smtp.isNotEmpty())
    return if (ADDRESS.matches(address) && password.isNotEmpty() && serversKnown) {
        MailPasswordAccount(
            provider = if (other) MailPasswordProvider.GENERIC else MailPasswordProvider.ICLOUD,
            address = address,
            password = password,
            imapHost = imap.takeIf { other },
            smtpHost = smtp.takeIf { other },
            caldavUrl = caldav.takeIf { other && it.isNotEmpty() },
        )
    } else {
        null
    }
}

/** Why a connect or a sign-in failed, from what the server answered; `null` is an unexpected failure. */
internal fun RepositoryResult.Failure?.toProblem(): InternetConnectFailure = when (this?.kind) {
    FailureKind.REJECTED -> InternetConnectFailure.REFUSED
    FailureKind.UNAVAILABLE -> InternetConnectFailure.UNAVAILABLE
    // A signed-in connect is not refused for its session (a rejected session signs the window out), and no other
    // kind names something the person can change.
    FailureKind.UNAUTHORIZED, FailureKind.NOT_FOUND, FailureKind.INVALID_DATA, null -> InternetConnectFailure.UNEXPECTED
}

private fun InternetOAuthProvider.toDomain() = when (this) {
    InternetOAuthProvider.GOOGLE -> OAuthProvider.GOOGLE
    InternetOAuthProvider.MICROSOFT -> OAuthProvider.MICROSOFT
}

/** The stored providers whose accounts sign in in a browser. */
internal val BROWSER_PROVIDERS = setOf("gmail", "outlook")

/** The stored providers whose accounts sign in with an address and a password. */
internal val PASSWORD_PROVIDERS = setOf("icloud", "generic")

internal fun InternetAccount.toItem(): InternetAccountItem {
    val mail = mailService()
    val calendars = calendarService()
    val provider = mailbox.provider
    return InternetAccountItem(
        id = mailbox.id,
        name = mailbox.name,
        address = mailbox.primaryAddress,
        provider = provider,
        mail = mail,
        calendars = calendars,
        canSignInAgain = (provider in BROWSER_PROVIDERS || provider in PASSWORD_PROVIDERS) &&
            InternetServiceStatus.NEEDS_REAUTHORIZATION in listOf(mail, calendars),
    )
}

/** Off while the switch is off; otherwise what the mail sync last reported. */
internal fun InternetAccount.mailService(): InternetServiceStatus =
    if (!mailEnabled) {
        InternetServiceStatus.OFF
    } else {
        when (mailbox.toStatus()) {
            MailAccountStatus.OK -> InternetServiceStatus.OK
            MailAccountStatus.SYNCING -> InternetServiceStatus.SYNCING
            MailAccountStatus.ERROR -> InternetServiceStatus.ERROR
            MailAccountStatus.NEEDS_REAUTHORIZATION -> InternetServiceStatus.NEEDS_REAUTHORIZATION
        }
    }

/** Off while the switch is off, whatever status the server still holds; otherwise the calendar sync's status. */
internal fun InternetAccount.calendarService(): InternetServiceStatus =
    if (!calendarsEnabled) {
        InternetServiceStatus.OFF
    } else {
        when (calendarStatus) {
            CalendarSyncStatus.OFF, CalendarSyncStatus.PENDING -> InternetServiceStatus.PENDING
            CalendarSyncStatus.NEVER -> InternetServiceStatus.SYNCING
            CalendarSyncStatus.NEEDS_CONSENT -> InternetServiceStatus.NEEDS_CONSENT
            CalendarSyncStatus.OK -> InternetServiceStatus.OK
            CalendarSyncStatus.ERROR -> InternetServiceStatus.ERROR
            CalendarSyncStatus.NEEDS_REAUTHORIZATION -> InternetServiceStatus.NEEDS_REAUTHORIZATION
        }
    }
