package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.domain.MailAccount
import cz.semprec.app.domain.MailRemovalImpact
import cz.semprec.app.domain.MailboxRepository
import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

private const val MIN_CONNECTIONS = 1
private const val MAX_CONNECTIONS = 15

/**
 * One mailbox: its name and connection limit, which the person may change, and its removal. A removal first reads what
 * it would hide and waits for the person's answer; nothing is removed before that. A change that the server refuses
 * puts the old value back and raises [MailAccountState.actionFailed].
 */
class MailAccountViewModel internal constructor(
    private val mailboxId: String,
    private val mailboxes: MailboxRepository,
) : ScreenViewModel<MailAccountState, MailAccountAction, MailAccountEffect>(MailAccountState()) {
    private var loadJob: Job? = null

    init {
        load()
    }

    override fun onAction(action: MailAccountAction) {
        if (isClosed) return
        when (action) {
            MailAccountAction.Retry -> load()
            is MailAccountAction.Rename -> rename(action.name.trim())
            is MailAccountAction.StepConnectionLimit -> stepLimit(action.delta)
            MailAccountAction.RequestRemoval -> requestRemoval()
            MailAccountAction.CancelRemoval ->
                if (state.value.removal == MailRemovalPhase.CONFIRMING) {
                    update { it.copy(removal = MailRemovalPhase.IDLE, impact = null) }
                }
            MailAccountAction.ConfirmRemoval -> confirmRemoval()
            MailAccountAction.DismissFailure -> update { it.copy(actionFailed = false) }
        }
    }

    private fun load() {
        loadJob?.cancel()
        update { MailAccountState() }
        loadJob = viewModelScope.launch {
            val result = mailAttempt { mailboxes.mailbox(mailboxId) }
            ensureActive()
            update {
                when (result) {
                    is RepositoryResult.Content ->
                        it.copy(phase = MailAccountPhase.CONTENT, account = result.value.toDetail())
                    is RepositoryResult.Failure -> it.copy(phase = MailAccountPhase.ERROR, failure = result.kind)
                    null -> it.copy(phase = MailAccountPhase.ERROR, failure = null)
                }
            }
        }
    }

    private fun rename(name: String) {
        val account = state.value.account
        if (account == null || name.isEmpty() || name == account.name) return
        change(account.copy(name = name), account) { mailboxes.rename(mailboxId, name) }
    }

    private fun stepLimit(delta: Int) {
        val account = state.value.account
        if (account == null || !account.connectionLimitApplies) return
        val limit = (account.connectionLimit + delta).coerceIn(MIN_CONNECTIONS, MAX_CONNECTIONS)
        if (limit != account.connectionLimit) {
            change(account.copy(connectionLimit = limit), account) { mailboxes.setConnectionLimit(mailboxId, limit) }
        }
    }

    /** Shows [next] at once and keeps it when [write] succeeds; otherwise shows [previous] again and says it failed. */
    private fun change(
        next: MailAccountDetail,
        previous: MailAccountDetail,
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

    private fun requestRemoval() {
        if (state.value.removal != MailRemovalPhase.IDLE || state.value.account == null) return
        update { it.copy(removal = MailRemovalPhase.LOADING_IMPACT) }
        viewModelScope.launch {
            val result = mailAttempt { mailboxes.removalImpact(mailboxId) }
            ensureActive()
            update {
                when (result) {
                    is RepositoryResult.Content ->
                        it.copy(removal = MailRemovalPhase.CONFIRMING, impact = result.value.toItem())
                    is RepositoryResult.Failure, null -> it.copy(removal = MailRemovalPhase.IDLE, actionFailed = true)
                }
            }
        }
    }

    private fun confirmRemoval() {
        if (state.value.removal != MailRemovalPhase.CONFIRMING) return
        update { it.copy(removal = MailRemovalPhase.REMOVING) }
        viewModelScope.launch {
            val result = mailAttempt { mailboxes.remove(mailboxId) }
            ensureActive()
            if (result is RepositoryResult.Content) {
                emit(MailAccountEffect.Removed)
            } else {
                update { it.copy(removal = MailRemovalPhase.CONFIRMING, actionFailed = true) }
            }
        }
    }
}

/** Puts back the fields of [previous] that [next] changed, and leaves what changed since alone. */
private fun MailAccountDetail.restore(next: MailAccountDetail, previous: MailAccountDetail) = copy(
    name = if (name == next.name) previous.name else name,
    connectionLimit = if (connectionLimit == next.connectionLimit) previous.connectionLimit else connectionLimit,
)

private fun MailAccount.toDetail() = MailAccountDetail(
    id = id,
    name = name,
    address = primaryAddress,
    provider = provider,
    syncMode = syncMode,
    status = toStatus(),
    lastSuccessfulSyncAt = lastSuccessfulSyncAt,
    failingSince = failingSince,
    connectionLimit = connectionLimit,
    connectionLimitApplies = connectionLimitApplies,
    autonomousSendProjectCount = autonomousSendProjectCount,
)

private fun MailRemovalImpact.toItem() = MailRemovalImpactItem(messages, drafts, threads, attachmentsKept)
