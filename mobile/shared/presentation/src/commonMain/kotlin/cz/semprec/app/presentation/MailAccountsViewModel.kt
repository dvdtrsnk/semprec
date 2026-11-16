package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.MailAccount
import cz.semprec.app.domain.MailPasswordAccount
import cz.semprec.app.domain.MailPasswordProvider
import cz.semprec.app.domain.MailboxRepository
import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

private val ADDRESS = Regex("^[^\\s@,]+@[^\\s@,]+$")

/**
 * The connected mailboxes and the form that connects one with an address and a password. Connecting is one request:
 * the server checks the login on its mail servers before it saves anything. A connected mailbox reloads the list.
 */
class MailAccountsViewModel internal constructor(
    private val mailboxes: MailboxRepository,
) : ScreenViewModel<MailAccountsState, MailAccountsAction, MailAccountsEffect>(MailAccountsState()) {
    private var loadJob: Job? = null

    init {
        load(showWait = true)
    }

    override fun onAction(action: MailAccountsAction) {
        if (isClosed) return
        when (action) {
            MailAccountsAction.Retry -> load(showWait = true)
            MailAccountsAction.Refresh -> load(showWait = state.value.phase != MailAccountsPhase.CONTENT)
            is MailAccountsAction.Open -> emit(MailAccountsEffect.OpenAccount(action.mailboxId))
            is MailAccountsAction.Connect -> connect(action)
            MailAccountsAction.DismissConnectFailure -> update { it.copy(connectFailure = null) }
        }
    }

    private fun load(showWait: Boolean) {
        loadJob?.cancel()
        update { if (showWait) MailAccountsState(connecting = it.connecting) else it.copy(refreshing = true) }
        loadJob = viewModelScope.launch {
            val result = mailAttempt { mailboxes.mailboxes() }
            ensureActive()
            update { it.after(result) }
        }
    }

    private fun MailAccountsState.after(result: RepositoryResult<List<MailAccount>>?): MailAccountsState =
        when (result) {
            is RepositoryResult.Content -> copy(
                phase = MailAccountsPhase.CONTENT,
                failure = null,
                refreshing = false,
                accounts = result.value.map { it.toItem() },
            )
            is RepositoryResult.Failure -> failed(result.kind)
            null -> failed(null)
        }

    /** A failed first load is an error; a failed refresh leaves the list that is shown as it was. */
    private fun MailAccountsState.failed(kind: FailureKind?): MailAccountsState =
        if (phase == MailAccountsPhase.CONTENT) {
            copy(refreshing = false)
        } else {
            copy(phase = MailAccountsPhase.ERROR, failure = kind)
        }

    private fun connect(form: MailAccountsAction.Connect) {
        if (state.value.connecting) return
        val account = form.toAccount()
        if (account == null) {
            update { it.copy(connectFailure = MailConnectFailure.INVALID_INPUT) }
            return
        }
        update { it.copy(connecting = true, connectFailure = null) }
        viewModelScope.launch {
            val result = mailAttempt { mailboxes.connect(account) }
            ensureActive()
            if (result is RepositoryResult.Content) {
                update { it.copy(connecting = false) }
                emit(MailAccountsEffect.Connected)
                load(showWait = false)
            } else {
                val problem = (result as? RepositoryResult.Failure).toProblem()
                update { it.copy(connecting = false, connectFailure = problem) }
            }
        }
    }
}

private fun MailAccountsAction.Connect.toAccount(): MailPasswordAccount? {
    val address = address.trim()
    val imap = imapHost.trim()
    val smtp = smtpHost.trim()
    val generic = kind == MailConnectKind.GENERIC
    val serversKnown = !generic || (imap.isNotEmpty() && smtp.isNotEmpty())
    return if (ADDRESS.matches(address) && password.isNotEmpty() && serversKnown) {
        MailPasswordAccount(
            provider = if (generic) MailPasswordProvider.GENERIC else MailPasswordProvider.ICLOUD,
            address = address,
            password = password,
            imapHost = imap.takeIf { generic },
            smtpHost = smtp.takeIf { generic },
        )
    } else {
        null
    }
}

private fun RepositoryResult.Failure?.toProblem(): MailConnectFailure = when (this?.kind) {
    FailureKind.REJECTED -> MailConnectFailure.REFUSED
    FailureKind.UNAVAILABLE -> MailConnectFailure.UNAVAILABLE
    else -> MailConnectFailure.UNEXPECTED
}

internal fun MailAccount.toItem() = MailAccountItem(id, name, primaryAddress, provider, toStatus())
