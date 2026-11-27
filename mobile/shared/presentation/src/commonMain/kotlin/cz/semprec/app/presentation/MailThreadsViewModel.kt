package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.MailContentRepository
import cz.semprec.app.domain.MailFacets
import cz.semprec.app.domain.MailRepository
import cz.semprec.app.domain.MailSearchResult
import cz.semprec.app.domain.MailThreadList
import cz.semprec.app.domain.MailboxRepository
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SyncMailThreadList
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.launch

/**
 * The thread list of the mail: all of it, or the threads of a project, a folder or one mailbox. A change of
 * the filter, the search or the context loads the list again and supersedes the load before it. While there is a
 * search the list is the answer of the mail search, which also asks each mailbox's provider
 * (see [MailThreadsState.remoteSearch]). Expected failures are state, cancellation is not. The facets of the filter
 * sheet and the mailboxes of the chips are secondary reads: a failure leaves the list as it is.
 *
 * A list that is not a search shows the rows the device kept for its view first ([MailThreadsState.fromCache]), then
 * the server's: only the changes since the kept rows when it can tell them, else the first page ([lists]). A write of
 * this window ([changes]) refreshes everything; a change the server reports ([remoteChanges], a mail thread's row or
 * the mail accounts) refreshes the list once it has been quiet for [REMOTE_REFRESH_DELAY_MILLIS].
 */
@OptIn(FlowPreview::class)
class MailThreadsViewModel internal constructor(
    private val mail: MailRepository,
    private val mailboxes: MailboxRepository,
    private val content: MailContentRepository,
    private val lists: SyncMailThreadList,
    start: MailListStart,
    changes: Flow<Unit> = emptyFlow(),
    remoteChanges: Flow<Unit> = emptyFlow(),
) : ScreenViewModel<MailThreadsState, MailThreadsAction, MailThreadsEffect>(
    MailThreadsState(
        box = start.box,
        mailboxId = start.mailboxId,
        folderId = start.folderId,
        projectId = start.projectId,
    ),
) {
    private var loadJob: Job? = null
    private var facetsJob: Job? = null
    private var mailboxesJob: Job? = null

    /** The rows of the shown view with its cursors; `null` while a search is shown or before the first answer. */
    private var list: MailThreadList? = null

    init {
        reloadOnChanges(changes) { onAction(MailThreadsAction.Refresh) }
        reloadOnChanges(remoteChanges.debounce(REMOTE_REFRESH_DELAY_MILLIS)) {
            val shown = state.value
            if (!isClosed && shown.search.isEmpty()) load(showWait = shown.phase != MailThreadsPhase.CONTENT)
        }
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
            is MailThreadsAction.SetProject -> change(reloadFacets = true) { it.withProject(action.projectId) }
            MailThreadsAction.ClearContext -> change(reloadFacets = true) { it.withoutContext() }
            is MailThreadsAction.ToggleRead -> toggleRead(action.threadId)
            MailThreadsAction.DismissFailure -> update { it.copy(actionFailed = false, actionRefusal = null) }
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
        if (showWait) list = null
        update {
            if (showWait) {
                it.copy(
                    phase = MailThreadsPhase.LOADING,
                    failure = null,
                    refreshing = false,
                    loadingMore = false,
                    hasMore = false,
                    threads = emptyList(),
                    remoteSearch = null,
                    fromCache = false,
                    actionFailed = false,
                    actionRefusal = null,
                )
            } else {
                it.copy(refreshing = true, loadingMore = false)
            }
        }
        val shown = state.value
        if (shown.search.isNotEmpty()) {
            loadJob = viewModelScope.launch {
                val result = mailAttempt { content.search(shown.search, shown.mailboxId) }
                ensureActive()
                update { it.afterSearch(result) }
            }
            return
        }
        val query = shown.toQuery(cursor = null)
        loadJob = viewModelScope.launch {
            if (list == null) {
                val cached = mailAttempt { RepositoryResult.Content(lists.cached(query)) }
                ensureActive()
                val kept = (cached as? RepositoryResult.Content)?.value
                if (kept != null) {
                    list = kept
                    update { it.withCached(kept) }
                }
            }
            val result = mailAttempt { lists.refresh(query, list) }
            ensureActive()
            if (result is RepositoryResult.Content) list = result.value
            update { it.afterLoad(result) }
        }
    }

    private fun loadMore() {
        val shown = list
        val cursor = shown?.nextCursor
        if (shown == null || cursor == null || loadJob?.isActive == true) return
        update { it.copy(loadingMore = true) }
        val query = state.value.toQuery(cursor)
        loadJob = viewModelScope.launch {
            val result = mailAttempt { mail.threads(query) }
            ensureActive()
            // The rows as they are now: a read mark set while the page loaded stays.
            val rows = list ?: shown
            val next = (result as? RepositoryResult.Content)?.let { lists.appended(query, rows, it.value) }
            ensureActive()
            if (next != null) list = next
            update { it.afterMore(next) }
        }
    }

    private fun loadFacets() {
        facetsJob?.cancel()
        val selected = state.value
        update { it.copy(facets = it.facets.copy(phase = MailFacetsPhase.LOADING)) }
        facetsJob = viewModelScope.launch {
            val result = mailAttempt { mail.facets(selected.projectId) }
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
                    val chips = result.value.map { account -> account.toChip() }
                    it.copy(
                        mailboxes = chips,
                        reauthorization = result.value.filter { account -> account.needsReauthorization() }
                            .map { account -> account.toNotice() },
                        remoteSearch = it.remoteSearch?.let { summary ->
                            summary.copy(failedAccounts = summary.failedAccounts.map { chip -> chip.id }.named(chips))
                        },
                    )
                }
            }
        }
    }

    private fun toggleRead(threadId: String) {
        val thread = state.value.threads.firstOrNull { it.threadId == threadId } ?: return
        val markRead = thread.unread
        showUnread(threadId, unread = !markRead)
        viewModelScope.launch {
            val result = mailWrite { mail.setRead(threadId, read = markRead) }
            ensureActive()
            when (result) {
                is MailWrite.Done -> showUnread(threadId, result.value)
                is MailWrite.Failed -> {
                    showUnread(threadId, unread = markRead)
                    update { it.copy(actionFailed = true, actionRefusal = result.refusal) }
                }
            }
        }
    }

    /** Marks the thread in the rows shown and in [list], which the next page and a refresh start from. */
    private fun showUnread(threadId: String, unread: Boolean) {
        list = list?.let { kept ->
            kept.copy(threads = kept.threads.map { if (it.threadId == threadId) it.copy(unread = unread) else it })
        }
        update { it.withUnread(threadId, unread) }
    }
}

/** How long the server's change reports must pause before the list asks for the changes. */
internal const val REMOTE_REFRESH_DELAY_MILLIS = 500L

private fun MailThreadsState.withUnread(threadId: String, unread: Boolean) =
    copy(threads = threads.map { if (it.threadId == threadId) it.copy(unread = unread) else it })

private fun MailThreadsState.afterLoad(result: RepositoryResult<MailThreadList>?): MailThreadsState =
    when (result) {
        is RepositoryResult.Content -> copy(
            phase = MailThreadsPhase.CONTENT,
            failure = null,
            refreshing = false,
            hasMore = result.value.nextCursor != null,
            threads = result.value.threads.map { it.toItem() },
            remoteSearch = null,
            fromCache = false,
        )
        is RepositoryResult.Failure -> failed(result.kind)
        null -> failed(null)
    }

private fun MailThreadsState.afterSearch(result: RepositoryResult<MailSearchResult>?): MailThreadsState =
    when (result) {
        is RepositoryResult.Content -> copy(
            phase = MailThreadsPhase.CONTENT,
            failure = null,
            refreshing = false,
            hasMore = false,
            threads = result.value.threads.map { it.toItem() },
            fromCache = false,
            remoteSearch = MailRemoteSearchSummary(
                unindexed = result.value.remote.unindexed,
                failedAccounts = result.value.remote.failed.named(mailboxes),
            ),
        )
        is RepositoryResult.Failure -> failed(result.kind)
        null -> failed(null)
    }

/**
 * A failed first load is an error; a failed refresh leaves the list that is shown as it was, the kept rows included,
 * and raises [MailThreadsState.actionFailed].
 */
private fun MailThreadsState.failed(kind: FailureKind?): MailThreadsState =
    if (phase == MailThreadsPhase.CONTENT) {
        copy(refreshing = false, loadingMore = false, actionFailed = true, actionRefusal = null)
    } else {
        copy(phase = MailThreadsPhase.ERROR, failure = kind)
    }

private fun MailThreadsState.afterMore(next: MailThreadList?): MailThreadsState =
    if (next == null) {
        copy(loadingMore = false, actionFailed = true, actionRefusal = null)
    } else {
        copy(loadingMore = false, hasMore = next.nextCursor != null, threads = next.threads.map { it.toItem() })
    }

private fun MailThreadsState.afterFacets(result: RepositoryResult<MailFacets>?): MailThreadsState = when (result) {
    is RepositoryResult.Content -> copy(
        projectName = result.value.selectedProjectName ?: projectName,
        facets = MailFacetsState(
            phase = MailFacetsPhase.READY,
            projectTotal = result.value.projectsTotal,
            projects = result.value.projects.map { it.toOption() },
        ),
    )
    is RepositoryResult.Failure, null -> copy(facets = facets.copy(phase = MailFacetsPhase.ERROR))
}

private fun MailThreadsState.togglingMailbox(mailboxId: String) =
    copy(mailboxId = if (this.mailboxId == mailboxId) null else mailboxId)

private fun MailThreadsState.withProject(projectId: String?) =
    copy(projectId = projectId, projectName = facets.projects.firstOrNull { it.id == projectId }?.name)

private fun MailThreadsState.withoutContext() =
    copy(projectId = null, projectName = null)
