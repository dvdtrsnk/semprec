package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.domain.InternetAccount
import cz.semprec.app.domain.InternetAccountRepository
import cz.semprec.app.domain.InternetService
import cz.semprec.app.domain.MailRemovalImpact
import cz.semprec.app.domain.MailboxRepository
import cz.semprec.app.domain.OAuthSignIn
import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch

private const val MIN_CONNECTIONS = 1
private const val MAX_CONNECTIONS = 15

/**
 * One internet account: its Mail and Calendars switches with what each service is doing, its name and connection
 * limit, a calendar sync on request, and its removal.
 *
 * Switching a service on writes at once; switching one off first waits for the person's answer, because the server
 * then removes what the service synced. A switch shows its new value and status at once; a write the server refuses
 * (for Mail off, also while the mailbox is in the middle of a sync) puts the old value back and raises
 * [InternetAccountState.actionFailed]. A written switch reads the account again so that the status is the server's,
 * and Calendars switched on raises [InternetAccountEffect.CalendarsTurnedOn].
 *
 * A Google or Microsoft account signs in again in a browser when a service no longer accepts its sign-in, and grants
 * the calendar permission the same way. The server keeps the account's sign-in as it was until the browser came back
 * and the code was accepted, so a cancelled or declined sign-in changes nothing; an accepted one reads the account
 * again. An iCloud or another password account signs in again with its password, which the server checks before it
 * keeps it; a refused one stays open with the reason, an accepted one reads the account again.
 *
 * A removal first reads what it would hide and waits for the answer; nothing is removed before that. A change of the
 * account data the server reports ([serverChanges]) reads the account again; the name and the connection limit stay
 * as shown, and the switches too while a switch is being written.
 */
class InternetAccountViewModel internal constructor(
    private val accountId: String,
    private val accounts: InternetAccountRepository,
    private val mailboxes: MailboxRepository,
    serverChanges: Flow<Unit>,
) : ScreenViewModel<InternetAccountState, InternetAccountAction, InternetAccountEffect>(InternetAccountState()) {
    private var loadJob: Job? = null
    private var statusJob: Job? = null
    private var switchWrites = 0

    private val browser = BrowserSignInFlow(
        scope = viewModelScope,
        open = { url -> emit(InternetAccountEffect.OpenSignIn(url)) },
        finish = accounts::finishSignIn,
        report = { report ->
            when (report) {
                BrowserSignInReport.Started -> update { it.copy(signingIn = true, signInFailure = null) }
                is BrowserSignInReport.Connected -> {
                    update { it.copy(signingIn = false) }
                    statusJob?.cancel()
                    readStatus()
                }
                is BrowserSignInReport.Stopped -> update { it.copy(signingIn = false, signInFailure = report.failure) }
            }
        },
    )

    private val password = PasswordSignInFlow(
        scope = viewModelScope,
        mailboxes = mailboxes,
        read = { state.value.passwordSignIn },
        write = { signIn -> update { it.copy(passwordSignIn = signIn) } },
        signedIn = {
            statusJob?.cancel()
            readStatus()
        },
    )

    init {
        load()
        reloadOnChanges(serverChanges, ::readStatus)
    }

    override fun onAction(action: InternetAccountAction) {
        if (isClosed) return
        when (action) {
            InternetAccountAction.Retry -> load()
            is InternetAccountAction.SetService -> switch(action.service, action.enabled, confirmed = action.enabled)
            InternetAccountAction.ConfirmServiceOff ->
                state.value.confirmingOff?.let { switch(it, enabled = false, confirmed = true) }
            InternetAccountAction.CancelServiceOff -> update { it.copy(confirmingOff = null) }
            is InternetAccountAction.Rename -> rename(action.name.trim())
            is InternetAccountAction.StepConnectionLimit -> stepLimit(action.delta)
            InternetAccountAction.SyncNow -> syncNow()
            is InternetAccountAction.Removal -> removal(action)
            InternetAccountAction.DismissFailure -> update { it.copy(actionFailed = false, signInFailure = null) }
            is InternetAccountAction.SignIn -> browser.handle(
                step = action,
                account = state.value.account,
                reauthorize = { services -> accounts.startReauthorization(accountId, services) },
                withPassword = { account -> password.open(accountId, account.address, account.provider) },
            )
            is InternetAccountAction.PasswordSignIn -> password.handle(action.step)
        }
    }

    private fun load() {
        loadJob?.cancel()
        statusJob?.cancel()
        update { InternetAccountState() }
        loadJob = viewModelScope.launch {
            val result = mailAttempt { accounts.account(accountId) }
            ensureActive()
            update {
                when (result) {
                    is RepositoryResult.Content ->
                        it.copy(phase = InternetAccountPhase.CONTENT, account = result.value.toDetail())
                    is RepositoryResult.Failure -> it.copy(phase = InternetAccountPhase.ERROR, failure = result.kind)
                    null -> it.copy(phase = InternetAccountPhase.ERROR, failure = null)
                }
            }
        }
    }

    /** Reads the status of a shown account again; a failed read changes nothing, and the next change tries again. */
    private fun readStatus() {
        if (state.value.phase != InternetAccountPhase.CONTENT || statusJob?.isActive == true) return
        statusJob = viewModelScope.launch {
            val read = mailAttempt { accounts.account(accountId) }
            val fresh = (read as? RepositoryResult.Content)?.value?.toDetail()
            ensureActive()
            if (fresh != null) {
                update { it.copy(account = it.account?.withStatusOf(fresh, switches = switchWrites == 0)) }
            }
        }
    }

    /** Writes the switch when [confirmed]; an unconfirmed switching off waits for [InternetAccountAction.ConfirmServiceOff]. */
    private fun switch(service: InternetAccountService, enabled: Boolean, confirmed: Boolean) {
        update { it.copy(confirmingOff = null) }
        val account = state.value.account ?: return
        when {
            account.isEnabled(service) == enabled -> Unit
            confirmed -> writeService(account, service, enabled)
            else -> update { it.copy(confirmingOff = service) }
        }
    }

    private fun writeService(account: InternetAccountDetail, service: InternetAccountService, enabled: Boolean) {
        val next = account.switched(service, enabled)
        update { it.copy(account = next) }
        switchWrites += 1
        viewModelScope.launch {
            val result = mailAttempt { accounts.setServiceEnabled(accountId, service.toDomain(), enabled) }
            ensureActive()
            switchWrites -= 1
            if (result is RepositoryResult.Content) {
                if (service == InternetAccountService.CALENDARS && enabled) {
                    emit(InternetAccountEffect.CalendarsTurnedOn)
                }
                statusJob?.cancel()
                readStatus()
            } else {
                update { current ->
                    current.copy(account = current.account?.unswitched(service, account), actionFailed = true)
                }
            }
        }
    }

    private fun syncNow() {
        val account = state.value.account
        if (account == null || !account.calendarsEnabled || state.value.syncRequested) return
        update { it.copy(syncRequested = true) }
        viewModelScope.launch {
            val result = mailAttempt { accounts.syncCalendars(accountId) }
            ensureActive()
            val failed = result !is RepositoryResult.Content
            update { it.copy(syncRequested = false, actionFailed = it.actionFailed || failed) }
        }
    }

    private fun rename(name: String) {
        val account = state.value.account
        if (account == null || name.isEmpty() || name == account.name) return
        change(account.copy(name = name), account) { mailboxes.rename(accountId, name) }
    }

    private fun stepLimit(delta: Int) {
        val account = state.value.account
        if (account == null || !account.connectionLimitApplies) return
        val limit = (account.connectionLimit + delta).coerceIn(MIN_CONNECTIONS, MAX_CONNECTIONS)
        if (limit != account.connectionLimit) {
            change(account.copy(connectionLimit = limit), account) { mailboxes.setConnectionLimit(accountId, limit) }
        }
    }

    /** Shows [next] at once and keeps it when [write] succeeds; otherwise shows [previous] again and says it failed. */
    private fun change(
        next: InternetAccountDetail,
        previous: InternetAccountDetail,
        write: suspend () -> RepositoryResult<Unit>,
    ) {
        update { it.copy(account = next) }
        viewModelScope.launch {
            val result = mailAttempt(write)
            ensureActive()
            if (result !is RepositoryResult.Content) {
                update { current ->
                    current.copy(account = current.account?.restore(next, previous), actionFailed = true)
                }
            }
        }
    }

    private fun removal(step: InternetAccountAction.Removal) {
        val idle = state.value.removal == InternetAccountRemovalPhase.IDLE
        val confirming = state.value.removal == InternetAccountRemovalPhase.CONFIRMING
        when (step) {
            InternetAccountAction.Removal.Request -> if (idle && state.value.account != null) runRemoval(false)
            InternetAccountAction.Removal.Cancel ->
                if (confirming) update { it.copy(removal = InternetAccountRemovalPhase.IDLE, impact = null) }
            InternetAccountAction.Removal.Confirm -> if (confirming) runRemoval(true)
        }
    }

    /** Reads what the removal would hide, or, once [confirmed], removes the account. */
    private fun runRemoval(confirmed: Boolean) {
        val running = when (confirmed) {
            true -> InternetAccountRemovalPhase.REMOVING
            false -> InternetAccountRemovalPhase.LOADING_IMPACT
        }
        update { it.copy(removal = running) }
        viewModelScope.launch {
            if (confirmed) {
                val result = mailAttempt { mailboxes.remove(accountId) }
                ensureActive()
                if (result is RepositoryResult.Content) {
                    emit(InternetAccountEffect.Removed)
                } else {
                    update { it.copy(removal = InternetAccountRemovalPhase.CONFIRMING, actionFailed = true) }
                }
            } else {
                val result = mailAttempt { mailboxes.removalImpact(accountId) }
                ensureActive()
                update {
                    when (result) {
                        is RepositoryResult.Content ->
                            it.copy(removal = InternetAccountRemovalPhase.CONFIRMING, impact = result.value.toImpact())
                        is RepositoryResult.Failure, null ->
                            it.copy(removal = InternetAccountRemovalPhase.IDLE, actionFailed = true)
                    }
                }
            }
        }
    }
}

/**
 * Starts a sign-in only while the screen offers it, and reports how the browser ended: signing in again is a browser
 * sign-in for a browser account, whose page [reauthorize] asks the server for, and [withPassword] otherwise.
 */
private fun BrowserSignInFlow.handle(
    step: InternetAccountAction.SignIn,
    account: InternetAccountDetail?,
    reauthorize: suspend (Set<InternetService>) -> RepositoryResult<OAuthSignIn>,
    withPassword: (InternetAccountDetail) -> Unit,
) {
    when (step) {
        InternetAccountAction.SignIn.Again -> when {
            account?.canSignInAgain != true -> Unit
            account.signsInInBrowser -> start { reauthorize(emptySet()) }
            else -> withPassword(account)
        }
        InternetAccountAction.SignIn.AllowCalendarAccess -> if (account?.canAllowCalendarAccess == true) {
            start { reauthorize(setOf(InternetService.MAIL, InternetService.CALENDARS)) }
        }
        is InternetAccountAction.SignIn.Returned -> returned(step.callbackUrl)
        InternetAccountAction.SignIn.Cancelled -> closed(failure = null)
        InternetAccountAction.SignIn.Failed -> closed(InternetConnectFailure.UNEXPECTED)
    }
}

private fun InternetAccountService.toDomain() = when (this) {
    InternetAccountService.MAIL -> InternetService.MAIL
    InternetAccountService.CALENDARS -> InternetService.CALENDARS
}

private fun InternetAccountDetail.isEnabled(service: InternetAccountService) = when (service) {
    InternetAccountService.MAIL -> mailEnabled
    InternetAccountService.CALENDARS -> calendarsEnabled
}

/** The switch of [service] set to [enabled], with the status the server is expected to report until it does. */
private fun InternetAccountDetail.switched(service: InternetAccountService, enabled: Boolean) = when (service) {
    InternetAccountService.MAIL -> copy(
        mailEnabled = enabled,
        mail = if (enabled) InternetServiceStatus.SYNCING else InternetServiceStatus.OFF,
    )
    InternetAccountService.CALENDARS -> copy(
        calendarsEnabled = enabled,
        calendars = if (enabled) InternetServiceStatus.PENDING else InternetServiceStatus.OFF,
    )
}

/** Puts the switch of [service] and its status back as they were in [previous]. */
private fun InternetAccountDetail.unswitched(service: InternetAccountService, previous: InternetAccountDetail) =
    when (service) {
        InternetAccountService.MAIL -> copy(mailEnabled = previous.mailEnabled, mail = previous.mail)
        InternetAccountService.CALENDARS ->
            copy(calendarsEnabled = previous.calendarsEnabled, calendars = previous.calendars)
    }

private fun InternetAccountDetail.withStatusOf(fresh: InternetAccountDetail, switches: Boolean) = copy(
    mailEnabled = if (switches) fresh.mailEnabled else mailEnabled,
    calendarsEnabled = if (switches) fresh.calendarsEnabled else calendarsEnabled,
    mail = if (switches) fresh.mail else mail,
    calendars = if (switches) fresh.calendars else calendars,
    lastSuccessfulSyncAt = fresh.lastSuccessfulSyncAt,
    failingSince = fresh.failingSince,
    syncedMessageCount = fresh.syncedMessageCount,
)

/** Puts back the fields of [previous] that [next] changed, and leaves what changed since alone. */
private fun InternetAccountDetail.restore(next: InternetAccountDetail, previous: InternetAccountDetail) = copy(
    name = if (name == next.name) previous.name else name,
    connectionLimit = if (connectionLimit == next.connectionLimit) previous.connectionLimit else connectionLimit,
)

private fun InternetAccount.toDetail() = InternetAccountDetail(
    id = mailbox.id,
    name = mailbox.name,
    address = mailbox.primaryAddress,
    provider = mailbox.provider,
    syncMode = mailbox.syncMode,
    mailEnabled = mailEnabled,
    calendarsEnabled = calendarsEnabled,
    mail = mailService(),
    calendars = calendarService(),
    lastSuccessfulSyncAt = mailbox.lastSuccessfulSyncAt,
    failingSince = mailbox.failingSince,
    connectionLimit = mailbox.connectionLimit,
    connectionLimitApplies = mailbox.connectionLimitApplies,
    autonomousSendProjectCount = mailbox.autonomousSendProjectCount,
    syncedMessageCount = mailbox.syncedMessageCount,
    signsInInBrowser = mailbox.provider in BROWSER_PROVIDERS,
    signsInWithPassword = mailbox.provider in PASSWORD_PROVIDERS,
)

private fun MailRemovalImpact.toImpact() = InternetAccountRemovalImpact(messages, drafts, threads, attachmentsKept)
