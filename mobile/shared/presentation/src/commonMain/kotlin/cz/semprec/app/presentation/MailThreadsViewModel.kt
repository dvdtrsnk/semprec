package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.MailFacets
import cz.semprec.app.domain.MailRepository
import cz.semprec.app.domain.MailThreadPage
import cz.semprec.app.domain.MailboxRepository
import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.launch

/**
 * The thread list of the mail: all of it, or the threads of an area, a project, a folder or one mailbox. A change of
 * the filter, the search or the context loads the list again and supersedes the load before it. Expected failures are
 * state, cancellation is not. The facets of the filter sheet and the mailboxes of the chips are secondary reads: a
 * failure leaves the list as it is.
 */
class MailThreadsViewModel internal constructor(
    private val mail: MailRepository,
    private val mailboxes: MailboxRepository,
    start: MailListStart,
    changes: Flow<Unit> = emptyFlow(),
) : ScreenViewModel<MailThreadsState, MailThreadsAction, MailThreadsEffect>(
    MailThreadsState(
        box = start.box,
        mailboxId = start.mailboxId,
        folderId = start.folderId,
        areaId = start.areaId,
        projectId = start.projectId,
    ),
) {
    private var loadJob: Job? = null
    private var facetsJob: Job? = null
    private var mailboxesJob: Job? = null
    private var nextCursor: String? = null

    init {
        reloadOnChanges(changes) { onAction(MailThreadsAction.Refresh) }
        load(showWait = true)
        loadFacets()
        loadMailboxes()
    }

    override fun onAction(action: MailThreadsAction) {
        if (isClosed) return
        when (action) {
            MailThreadsAction.Retry -> load(showWait = true)
            MailThreadsAction.Refresh -> {
                load(showWait = state.value.phase != MailThreadsPhase.CONTENT)
                loadFacets()
                loadMailboxes()
            }
            MailThreadsAction.LoadMore -> loadMore()
            is MailThreadsAction.Search -> change { it.copy(search = action.text.trim()) }
            is MailThreadsAction.SelectFilter -> change { it.copy(filter = action.filter) }
            is MailThreadsAction.SelectMailbox -> change { it.togglingMailbox(action.mailboxId) }
            is MailThreadsAction.SetArea -> change(reloadFacets = true) { it.withArea(action.areaId) }
            is MailThreadsAction.SetProject -> change(reloadFacets = true) { it.withProject(action.projectId) }
            MailThreadsAction.ClearContext -> change(reloadFacets = true) { it.withoutContext() }
            is MailThreadsAction.ToggleRead -> toggleRead(action.threadId)
            MailThreadsAction.DismissFailure -> update { it.copy(actionFailed = false) }
            is MailThreadsAction.Open -> emit(action.target)
        }
    }

    /**
     * Applies a change of what the list shows and loads the list again behind a wait. A change that does not alter
     * the state loads nothing.
     */
    private fun change(reloadFacets: Boolean = false, transform: (MailThreadsState) -> MailThreadsState) {
        if (transform(state.value) == state.value) return
        update(transform)
        load(showWait = true)
        if (reloadFacets) loadFacets()
    }

    private fun load(showWait: Boolean) {
        loadJob?.cancel()
        nextCursor = null
        update {
            if (showWait) {
                it.copy(
                    phase = MailThreadsPhase.LOADING,
                    failure = null,
                    refreshing = false,
                    loadingMore = false,
                    hasMore = false,
                    threads = emptyList(),
                    actionFailed = false,
                )
            } else {
                it.copy(refreshing = true, loadingMore = false)
            }
        }
        val query = state.value.toQuery(cursor = null)
        loadJob = viewModelScope.launch {
            val result = mailAttempt { mail.threads(query) }
            ensureActive()
            nextCursor = (result as? RepositoryResult.Content)?.value?.nextCursor
            update { it.afterLoad(result) }
        }
    }

    private fun loadMore() {
        val cursor = nextCursor
        if (cursor == null || loadJob?.isActive == true) return
        update { it.copy(loadingMore = true) }
        val query = state.value.toQuery(cursor)
        loadJob = viewModelScope.launch {
            val result = mailAttempt { mail.threads(query) }
            ensureActive()
            if (result is RepositoryResult.Content) nextCursor = result.value.nextCursor
            update { it.afterMore(result) }
        }
    }

    private fun loadFacets() {
        facetsJob?.cancel()
        val selected = state.value
        update { it.copy(facets = it.facets.copy(phase = MailFacetsPhase.LOADING)) }
        facetsJob = viewModelScope.launch {
            val result = mailAttempt { mail.facets(selected.areaId, selected.projectId) }
            ensureActive()
            update { it.afterFacets(result) }
        }
    }

    private fun loadMailboxes() {
        mailboxesJob?.cancel()
        mailboxesJob = viewModelScope.launch {
            val result = mailAttempt { mailboxes.mailboxes() }
            ensureActive()
            if (result is RepositoryResult.Content) {
                update {
                    it.copy(
                        mailboxes = result.value.map { account -> account.toChip() },
                        reauthorization = result.value.filter { account -> account.needsReauthorization() }
                            .map { account -> account.toNotice() },
                    )
                }
            }
        }
    }

    private fun toggleRead(threadId: String) {
        val thread = state.value.threads.firstOrNull { it.threadId == threadId } ?: return
        val markRead = thread.unread
        update { it.withUnread(threadId, unread = !markRead) }
        viewModelScope.launch {
            val result = mailAttempt { mail.setRead(threadId, read = markRead) }
            ensureActive()
            when (result) {
                is RepositoryResult.Content -> update { it.withUnread(threadId, result.value) }
                is RepositoryResult.Failure, null ->
                    update { it.withUnread(threadId, unread = markRead).copy(actionFailed = true) }
            }
        }
    }
}

private fun MailThreadsState.withUnread(threadId: String, unread: Boolean) =
    copy(threads = threads.map { if (it.threadId == threadId) it.copy(unread = unread) else it })

private fun MailThreadsState.afterLoad(result: RepositoryResult<MailThreadPage>?): MailThreadsState =
    when (result) {
        is RepositoryResult.Content -> copy(
            phase = MailThreadsPhase.CONTENT,
            failure = null,
            refreshing = false,
            hasMore = result.value.nextCursor != null,
            threads = result.value.threads.map { it.toItem() },
        )
        is RepositoryResult.Failure -> failed(result.kind)
        null -> failed(null)
    }

/** A failed first load is an error; a failed refresh leaves the list that is shown as it was. */
private fun MailThreadsState.failed(kind: FailureKind?): MailThreadsState =
    if (phase == MailThreadsPhase.CONTENT) {
        copy(refreshing = false, loadingMore = false, actionFailed = true)
    } else {
        copy(phase = MailThreadsPhase.ERROR, failure = kind)
    }

private fun MailThreadsState.afterMore(result: RepositoryResult<MailThreadPage>?): MailThreadsState =
    when (result) {
        is RepositoryResult.Content -> {
            val known = threads.mapTo(HashSet()) { it.threadId }
            copy(
                loadingMore = false,
                hasMore = result.value.nextCursor != null,
                threads = threads + result.value.threads.filter { it.threadId !in known }.map { it.toItem() },
            )
        }
        is RepositoryResult.Failure, null -> copy(loadingMore = false, actionFailed = true)
    }

private fun MailThreadsState.afterFacets(result: RepositoryResult<MailFacets>?): MailThreadsState = when (result) {
    is RepositoryResult.Content -> copy(
        areaName = result.value.selectedAreaName ?: areaName,
        projectName = result.value.selectedProjectName ?: projectName,
        facets = MailFacetsState(
            phase = MailFacetsPhase.READY,
            areaTotal = result.value.areasTotal,
            projectTotal = result.value.projectsTotal,
            areas = result.value.areas.map { it.toOption() },
            projects = result.value.projects.map { it.toOption() },
        ),
    )
    is RepositoryResult.Failure, null -> copy(facets = facets.copy(phase = MailFacetsPhase.ERROR))
}

private fun MailThreadsState.togglingMailbox(mailboxId: String) =
    copy(mailboxId = if (this.mailboxId == mailboxId) null else mailboxId)

private fun MailThreadsState.withArea(areaId: String?): MailThreadsState {
    val projectArea = facets.projects.firstOrNull { it.id == projectId }?.areaId
    val keepProject = areaId == null || projectArea == areaId
    return copy(
        areaId = areaId,
        areaName = facets.areas.firstOrNull { it.id == areaId }?.name,
        projectId = if (keepProject) projectId else null,
        projectName = if (keepProject) projectName else null,
    )
}

private fun MailThreadsState.withProject(projectId: String?) =
    copy(projectId = projectId, projectName = facets.projects.firstOrNull { it.id == projectId }?.name)

private fun MailThreadsState.withoutContext() =
    copy(areaId = null, projectId = null, areaName = null, projectName = null)
