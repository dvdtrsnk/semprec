package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.domain.LoadPlaceholderItems
import cz.semprec.app.domain.PlaceholderItem
import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/** Loads the placeholder list. Expected failures are state, cancellation is not; a retry supersedes the last load. */
class HomeViewModel internal constructor(private val loadItems: LoadPlaceholderItems) :
    ScreenViewModel<HomeState, HomeAction, HomeEffect>(HomeState()) {
    private var loadJob: Job? = null

    init {
        load()
    }

    override fun onAction(action: HomeAction) {
        if (isClosed) return
        when (action) {
            HomeAction.Retry -> load()
            is HomeAction.SelectItem -> emit(HomeEffect.OpenDetail(action.id))
        }
    }

    private fun load() {
        loadJob?.cancel()
        update { HomeState() }
        loadJob = viewModelScope.launch {
            val next = try {
                loadItems().toState()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                HomeState(HomePhase.ERROR)
            }
            ensureActive()
            update { next }
        }
    }
}

private fun RepositoryResult<List<PlaceholderItem>>.toState(): HomeState = when (this) {
    is RepositoryResult.Failure -> HomeState(HomePhase.ERROR, failure = kind)
    is RepositoryResult.Content -> {
        val items = value.map { it.toHomeItem() }
        HomeState(if (items.isEmpty()) HomePhase.EMPTY else HomePhase.CONTENT, items)
    }
}
