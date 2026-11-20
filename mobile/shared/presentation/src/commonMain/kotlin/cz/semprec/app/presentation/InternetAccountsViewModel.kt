package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CalendarSyncStatus
import cz.semprec.app.domain.InternetAccount
import cz.semprec.app.domain.InternetAccountRepository
import cz.semprec.app.domain.MailPasswordAccount
import cz.semprec.app.domain.MailPasswordProvider
import cz.semprec.app.domain.MailboxRepository
import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch

private val ADDRESS = Regex("^[^\\s@,]+@[^\\s@,]+$")

/**
 * The internet accounts with what each of their services is doing, and the form that connects one with an address
 * and a password. Connecting is one request: the server checks the login on its mail servers before it saves
 * anything. A connected account reloads the list. A change of the account data the server reports ([serverChanges])
 * reads the list again unless a read is under way, so the statuses follow the server's.
 */
class InternetAccountsViewModel internal constructor(
    private val accounts: InternetAccountRepository,
    private val mailboxes: MailboxRepository,
    serverChanges: Flow<Unit>,
) : ScreenViewModel<InternetAccountsState, InternetAccountsAction, InternetAccountsEffect>(InternetAccountsState()) {
    private var loadJob: Job? = null

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
            InternetAccountsAction.DismissConnectFailure -> update { it.copy(connectFailure = null) }
        }
    }

    private fun load(showWait: Boolean) {
        loadJob?.cancel()
        update { if (showWait) InternetAccountsState(connecting = it.connecting) else it.copy(refreshing = true) }
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

    private fun connect(form: InternetAccountsAction.Connect) {
        if (state.value.connecting) return
        val account = form.toAccount()
        if (account == null) {
            update { it.copy(connectFailure = InternetConnectFailure.INVALID_INPUT) }
            return
        }
        update { it.copy(connecting = true, connectFailure = null) }
        viewModelScope.launch {
            val result = mailAttempt { mailboxes.connect(account) }
            ensureActive()
            if (result is RepositoryResult.Content) {
                update { it.copy(connecting = false) }
                emit(InternetAccountsEffect.Connected)
                load(showWait = false)
            } else {
                val problem = (result as? RepositoryResult.Failure).toProblem()
                update { it.copy(connecting = false, connectFailure = problem) }
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

private fun RepositoryResult.Failure?.toProblem(): InternetConnectFailure = when (this?.kind) {
    FailureKind.REJECTED -> InternetConnectFailure.REFUSED
    FailureKind.UNAVAILABLE -> InternetConnectFailure.UNAVAILABLE
    else -> InternetConnectFailure.UNEXPECTED
}

internal fun InternetAccount.toItem() = InternetAccountItem(
    id = mailbox.id,
    name = mailbox.name,
    address = mailbox.primaryAddress,
    provider = mailbox.provider,
    mail = mailService(),
    calendars = calendarService(),
)

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
