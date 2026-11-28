package cz.alldots.app.presentation

import androidx.lifecycle.viewModelScope
import cz.alldots.app.domain.OfflineStatusSource
import cz.alldots.app.domain.RepositoryResult
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch

/**
 * What a signed-in window tells of the changes it has not brought to the server: whether it is [offline], how many
 * changes are [waiting] to be sent, and how many the server refused ([failed]) since they were dismissed.
 */
data class SyncStatusState(val offline: Boolean = false, val waiting: Int = 0, val failed: Int = 0)

sealed interface SyncStatusAction {
    /** The person saw the refused changes; they are forgotten until another one is refused. */
    data object DismissFailures : SyncStatusAction
}

/**
 * The status of the changes of the signed-in account (docs/adr/2026-11-23-mobile-writes-wait-in-an-ordered-queue-
 * without-a-connection.md): it follows [source] for as long as the ViewModel lives.
 */
class SyncStatusViewModel internal constructor(
    private val source: OfflineStatusSource,
) : ScreenViewModel<SyncStatusState, SyncStatusAction, Nothing>(SyncStatusState()) {
    init {
        source.status
            .onEach { status -> update { SyncStatusState(status.offline, status.waiting, status.failed) } }
            .launchIn(viewModelScope)
    }

    override fun onAction(action: SyncStatusAction) {
        if (isClosed) return
        when (action) {
            SyncStatusAction.DismissFailures -> viewModelScope.launch {
                // A forgetting that failed leaves the failures, which the status goes on showing.
                guarded {
                    source.forgetFailures()
                    RepositoryResult.Content(Unit)
                }
            }
        }
    }
}
