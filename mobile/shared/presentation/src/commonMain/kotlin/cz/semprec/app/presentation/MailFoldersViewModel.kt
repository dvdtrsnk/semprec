package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.MailAccount
import cz.semprec.app.domain.MailFolder
import cz.semprec.app.domain.MailRepository
import cz.semprec.app.domain.MailSummary
import cz.semprec.app.domain.MailSyncStatus
import cz.semprec.app.domain.MailboxRepository
import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/**
 * The mailboxes: smart boxes with their counts, then every account with its folders. A folder that cannot be read
 * leaves its account without folders and the rest of the screen as it is; a failed summary or account list is an
 * error. Opening a row raises the thread list it stands for as the effect. While an account syncs on the server the
 * screen is read again, so its status, folders and counts follow the server's.
 */
class MailFoldersViewModel internal constructor(
    private val mail: MailRepository,
    private val mailboxes: MailboxRepository,
) : ScreenViewModel<MailFoldersState, MailFoldersAction, MailFoldersEffect>(MailFoldersState()) {
    private var loadJob: Job? = null
    private var pollJob: Job? = null
    private var collapsed: Set<String> = emptySet()

    init {
        load(showWait = true)
    }

    override fun onAction(action: MailFoldersAction) {
        if (isClosed) return
        when (action) {
            MailFoldersAction.Retry -> load(showWait = true)
            MailFoldersAction.Refresh -> load(showWait = state.value.phase != MailFoldersPhase.CONTENT)
            is MailFoldersAction.ToggleAccount -> toggle(action.mailboxId)
            is MailFoldersAction.OpenBox -> emit(MailFoldersEffect.OpenList(MailListStart(box = action.box), null))
            is MailFoldersAction.OpenFolder -> openFolder(action.mailboxId, action.folderId)
            MailFoldersAction.Compose -> emit(MailFoldersEffect.Compose)
            MailFoldersAction.OpenAccounts -> emit(MailFoldersEffect.OpenAccounts)
        }
    }

    private fun openFolder(mailboxId: String, folderId: String) {
        val folder = state.value.accounts.firstOrNull { it.id == mailboxId }?.folders?.firstOrNull { it.id == folderId }
        emit(MailFoldersEffect.OpenList(MailListStart(mailboxId = mailboxId, folderId = folderId), folder?.name))
    }

    private fun toggle(mailboxId: String) {
        collapsed = if (mailboxId in collapsed) collapsed - mailboxId else collapsed + mailboxId
        update { it.copy(accounts = it.accounts.map { a -> a.copy(collapsed = a.id in collapsed) }) }
    }

    private fun load(showWait: Boolean) {
        loadJob?.cancel()
        update { if (showWait) MailFoldersState() else it.copy(refreshing = true) }
        loadJob = viewModelScope.launch {
            val accounts = mailAttempt { mailboxes.mailboxes() }
            val summary = if (accounts is RepositoryResult.Content) mailAttempt { mail.summary() } else null
            val folders = (accounts as? RepositoryResult.Content)?.value.orEmpty().map { account ->
                account to mailAttempt { mailboxes.folders(account.id) }
            }
            ensureActive()
            update { it.after(accounts, summary, folders) }
            pollWhileSyncing()
        }
    }

    private fun pollWhileSyncing() {
        pollJob?.cancel()
        if (state.value.accounts.none { it.status == MailAccountStatus.SYNCING }) return
        pollJob = viewModelScope.launch {
            delay(MAIL_SYNC_POLL_MILLIS)
            if (loadJob?.isActive != true) load(showWait = false)
        }
    }

    private fun MailFoldersState.after(
        accounts: RepositoryResult<List<MailAccount>>?,
        summary: RepositoryResult<MailSummary>?,
        folders: List<Pair<MailAccount, RepositoryResult<List<MailFolder>>?>>,
    ): MailFoldersState = when {
        accounts is RepositoryResult.Failure -> failed(accounts.kind)
        accounts == null || summary == null -> failed(null)
        summary is RepositoryResult.Failure -> failed(summary.kind)
        else -> {
            val counts = (summary as RepositoryResult.Content).value
            MailFoldersState(
                phase = MailFoldersPhase.CONTENT,
                unreadInbox = counts.unreadInbox,
                flagged = counts.flagged,
                sempDrafts = counts.sempDrafts,
                accounts = folders.map { (account, result) ->
                    account.toFolderAccount(result, account.id in collapsed)
                },
            )
        }
    }

    /** A failed first load is an error; a failed refresh leaves the content that is shown as it was. */
    private fun MailFoldersState.failed(kind: FailureKind?): MailFoldersState =
        if (phase == MailFoldersPhase.CONTENT) {
            copy(refreshing = false)
        } else {
            MailFoldersState(phase = MailFoldersPhase.ERROR, failure = kind)
        }
}

private fun MailAccount.toFolderAccount(
    result: RepositoryResult<List<MailFolder>>?,
    collapsed: Boolean,
) = MailFolderAccount(
    id = id,
    name = name,
    address = primaryAddress,
    status = toStatus(),
    folders = (result as? RepositoryResult.Content)?.value.orEmpty()
        .map { MailFolderItem(it.id, it.name, it.specialPurpose, it.unreadCount) },
    foldersFailed = result !is RepositoryResult.Content,
    collapsed = collapsed,
)

internal fun MailAccount.toStatus(): MailAccountStatus = when (syncStatus) {
    MailSyncStatus.NEEDS_REAUTHORIZATION -> MailAccountStatus.NEEDS_REAUTHORIZATION
    MailSyncStatus.ERROR -> MailAccountStatus.ERROR
    MailSyncStatus.NEVER -> MailAccountStatus.SYNCING
    MailSyncStatus.OK -> if (initialSyncInProgress) MailAccountStatus.SYNCING else MailAccountStatus.OK
}
