package cz.alldots.app.presentation

import androidx.lifecycle.viewModelScope
import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.AuthRepository
import cz.alldots.app.domain.LoadOverview
import cz.alldots.app.domain.Overview
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.SessionStatus
import cz.alldots.app.domain.SessionUser
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.launch

/**
 * The overview: what waits in the Inbox and the mail, pinned projects and collections. A row raises its [OverviewTarget] as the effect.
 * Expected failures are state, cancellation is not; a retry or a refresh supersedes the load before it.
 */
class OverviewViewModel internal constructor(
    private val loadOverview: LoadOverview,
    private val auth: AuthRepository,
    changes: Flow<Unit> = emptyFlow(),
) : ScreenViewModel<OverviewState, OverviewAction, OverviewTarget>(OverviewState()) {
    private var loadJob: Job? = null

    init {
        reloadOnChanges(changes) { onAction(OverviewAction.Refresh) }
        load(showWait = true)
    }

    override fun onAction(action: OverviewAction) {
        if (isClosed) return
        when (action) {
            OverviewAction.Retry -> load(showWait = true)
            // Without content to keep on screen, a refresh is a retry.
            OverviewAction.Refresh -> load(showWait = state.value.phase != OverviewPhase.CONTENT)
            is OverviewAction.Open -> emit(action.target)
        }
    }

    private fun load(showWait: Boolean) {
        loadJob?.cancel()
        val account = account()
        update {
            if (showWait) {
                OverviewState(accountEmail = account?.email, accountName = account?.displayName)
            } else {
                it.copy(refreshing = true)
            }
        }
        loadJob = viewModelScope.launch {
            val result: RepositoryResult<Overview>? = try {
                loadOverview()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                null
            }
            ensureActive()
            update { it.after(result, account()) }
        }
    }

    private fun account(): SessionUser? = (auth.status.value as? SessionStatus.SignedIn)?.session?.user
}

private fun OverviewState.after(result: RepositoryResult<Overview>?, account: SessionUser?): OverviewState =
    when (result) {
        is RepositoryResult.Content -> result.value.toState(account)
        is RepositoryResult.Failure -> failed(result.kind)
        null -> failed(null)
    }

/** A failed first load is an error; a failed refresh leaves the content that is shown as it was. */
private fun OverviewState.failed(kind: FailureKind?): OverviewState =
    if (phase == OverviewPhase.CONTENT) copy(refreshing = false) else OverviewState(OverviewPhase.ERROR, kind)

private fun Overview.toState(account: SessionUser?) = OverviewState(
    phase = OverviewPhase.CONTENT,
    accountEmail = account?.email,
    accountName = account?.displayName,
    inboxPending = summary.inboxPending,
    mailUnread = summary.mailUnread,
    problemCount = summary.problemCount,
    projects = projects.map { OverviewProjectItem(it.id, it.name, it.color, it.status) },
    collections = collections.map {
        OverviewCollectionItem(it.databaseId, it.ownerModuleId, it.name, it.icon, it.color)
    },
)
