package cz.alldots.app.presentation

import androidx.lifecycle.viewModelScope
import cz.alldots.app.core.FailureKind
import cz.alldots.app.core.SearchGroupType
import cz.alldots.app.domain.RecentSearches
import cz.alldots.app.domain.RememberRecentSearch
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.SearchEverything
import cz.alldots.app.domain.SearchGroup
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

private const val DEBOUNCE_MILLIS = 250L

/**
 * The search overlay. A newer text or scope supersedes the search before it, so a late answer never replaces a newer
 * one; the recent searches live in [recents], which the app scene shares between the overlays it opens.
 */
class SearchViewModel internal constructor(
    private val search: SearchEverything,
    private val remember: RememberRecentSearch,
    private val recents: RecentSearches,
) : ScreenViewModel<SearchState, SearchAction, SearchEffect>(SearchState(recents = recents.list())) {
    private var query = ""
    private var searchJob: Job? = null

    override fun onAction(action: SearchAction) {
        if (isClosed) return
        when (action) {
            is SearchAction.QueryChanged -> {
                query = action.text
                startSearch(wait = true)
            }
            is SearchAction.SelectScope -> {
                update { it.copy(scope = action.scope) }
                startSearch(wait = false)
            }
            is SearchAction.Submit -> submit(action.text)
            SearchAction.Retry -> startSearch(wait = false)
            is SearchAction.Open -> open(action.type, action.key)
        }
    }

    private fun submit(text: String) {
        query = text
        remember(text)
        update { it.copy(recents = recents.list()) }
        if (state.value.phase == SearchPhase.SEARCHING) startSearch(wait = false)
    }

    private fun open(type: SearchGroupType, key: String) {
        val group = state.value.groups.firstOrNull { it.type == type }
        val result = group?.results?.firstOrNull { it.key == key } ?: return
        emit(
            SearchEffect.OpenResult(
                type = type,
                itemId = result.itemId,
                threadId = result.threadId,
                databaseKey = result.databaseKey,
                journalType = result.journalType,
                journalPeriod = result.journalPeriod,
            ),
        )
    }

    private fun startSearch(wait: Boolean) {
        searchJob?.cancel()
        if (query.isBlank()) {
            update { SearchState(scope = it.scope, recents = recents.list()) }
            return
        }
        update { it.copy(phase = SearchPhase.SEARCHING, failure = null) }
        val scope = state.value.scope
        val text = query
        searchJob = viewModelScope.launch {
            if (wait) delay(DEBOUNCE_MILLIS)
            val result: RepositoryResult<List<SearchGroup>>? = try {
                search(text, scope)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                null
            }
            ensureActive()
            update { it.after(result) }
        }
    }
}

private fun SearchState.after(result: RepositoryResult<List<SearchGroup>>?): SearchState = when (result) {
    is RepositoryResult.Content -> copy(
        phase = if (result.value.isEmpty()) SearchPhase.EMPTY else SearchPhase.RESULTS,
        failure = null,
        groups = result.value.map { it.toItem() },
    )
    is RepositoryResult.Failure -> failed(result.kind)
    null -> failed(null)
}

private fun SearchState.failed(kind: FailureKind?) =
    copy(phase = SearchPhase.ERROR, failure = kind, groups = emptyList())

private fun SearchGroup.toItem() = SearchGroupItem(
    type = type,
    total = total,
    results = results.map { result ->
        SearchResultItem(
            key = result.threadId ?: result.itemId.orEmpty(),
            itemId = result.itemId,
            threadId = result.threadId,
            databaseKey = result.databaseKey,
            title = result.title,
            subtitle = result.subtitle.map { SearchSubtitleItem(it.kind, it.value, it.itemId) },
            snippet = result.snippet,
            journalType = result.journalType,
            journalPeriod = result.journalPeriod,
        )
    },
)
