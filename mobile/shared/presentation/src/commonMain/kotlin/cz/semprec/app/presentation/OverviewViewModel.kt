package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.AuthRepository
import cz.semprec.app.domain.LoadOverview
import cz.semprec.app.domain.Overview
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SessionStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/**
 * The overview: counts, areas, pinned projects and collections. A row raises its [OverviewTarget] as the effect.
 * Expected failures are state, cancellation is not; a retry or a refresh supersedes the load before it.
 */
class OverviewViewModel internal constructor(
    private val loadOverview: LoadOverview,
    private val auth: AuthRepository,
) : ScreenViewModel<OverviewState, OverviewAction, OverviewTarget>(OverviewState()) {
    private var loadJob: Job? = null

    init {
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
        update { if (showWait) OverviewState(accountEmail = accountEmail()) else it.copy(refreshing = true) }
        loadJob = viewModelScope.launch {
            val result: RepositoryResult<Overview>? = try {
                loadOverview()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                null
            }
            ensureActive()
            update { it.after(result, accountEmail()) }
        }
    }

    private fun accountEmail(): String? = (auth.status.value as? SessionStatus.SignedIn)?.session?.user?.email
}

private fun OverviewState.after(result: RepositoryResult<Overview>?, email: String?): OverviewState = when (result) {
    is RepositoryResult.Content -> result.value.toState(email)
    is RepositoryResult.Failure -> failed(result.kind)
    null -> failed(null)
}

/** A failed first load is an error; a failed refresh leaves the content that is shown as it was. */
private fun OverviewState.failed(kind: FailureKind?): OverviewState =
    if (phase == OverviewPhase.CONTENT) copy(refreshing = false) else OverviewState(OverviewPhase.ERROR, kind)

private fun Overview.toState(email: String?) = OverviewState(
    phase = OverviewPhase.CONTENT,
    accountEmail = email,
    inboxPending = summary.inboxPending,
    mailUnread = summary.mailUnread,
    tasksToday = summary.tasksToday,
    problemCount = summary.problemCount,
    journalTodayItemId = summary.journalTodayItemId,
    areas = areas.map { OverviewAreaItem(it.id, it.name, it.color, it.icon, it.activeProjectCount) },
    projects = projects.map { OverviewProjectItem(it.id, it.name, it.color, it.areaName, it.status) },
    collections = collections.map {
        OverviewCollectionItem(it.databaseId, it.ownerModuleId, it.name, it.icon, it.color, it.itemCount)
    },
)
