package cz.semprec.app.presentation

import androidx.lifecycle.viewModelScope
import cz.semprec.app.domain.LoadPlaceholderItem
import cz.semprec.app.domain.PlaceholderItem
import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/** Loads one item. An unknown id is [DetailPhase.NOT_FOUND], not a failure. The screen has no effects. */
class DetailViewModel internal constructor(
    private val itemId: String,
    private val loadItem: LoadPlaceholderItem,
) : ScreenViewModel<DetailState, DetailAction, Nothing>(DetailState()) {
    private var loadJob: Job? = null

    init {
        load()
    }

    override fun onAction(action: DetailAction) {
        if (isClosed) return
        when (action) {
            DetailAction.Retry -> load()
        }
    }

    private fun load() {
        loadJob?.cancel()
        update { DetailState() }
        loadJob = viewModelScope.launch {
            val next = try {
                loadItem(itemId).toState()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                DetailState(DetailPhase.ERROR)
            }
            ensureActive()
            update { next }
        }
    }
}

private fun RepositoryResult<PlaceholderItem?>.toState(): DetailState = when (this) {
    is RepositoryResult.Failure -> DetailState(DetailPhase.ERROR, failure = kind)
    is RepositoryResult.Content -> value?.let { DetailState(DetailPhase.CONTENT, it.toHomeItem()) }
        ?: DetailState(DetailPhase.NOT_FOUND)
}
