package cz.semprec.app.presentation

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SyncAccountCalendars
import kotlinx.coroutines.launch

/**
 * Asks for the internet accounts' calendars to be synced without waiting for it. The screen shows nothing of the
 * request: what the sync brings comes through the sync socket, and a sync that fails shows as the account's status.
 */
internal fun ViewModel.requestAccountSync(sync: SyncAccountCalendars) {
    viewModelScope.launch {
        guarded {
            sync()
            RepositoryResult.Content(Unit)
        }
    }
}
