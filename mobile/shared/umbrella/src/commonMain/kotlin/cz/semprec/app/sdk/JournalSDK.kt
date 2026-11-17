package cz.semprec.app.sdk

import cz.semprec.app.data.AuthenticatedApi
import cz.semprec.app.data.HttpInboxCaptureRepository
import cz.semprec.app.data.HttpJournalRepository
import cz.semprec.app.presentation.InboxCaptureViewModel
import cz.semprec.app.presentation.JournalSubpageViewModel
import cz.semprec.app.presentation.JournalViewModel
import cz.semprec.app.presentation.JournalViewModelFactory

/** The diary part of [HomeSDK]. Every call creates a new ViewModel that the caller owns. */
class JournalSDK internal constructor(api: AuthenticatedApi) {
    private val viewModels =
        JournalViewModelFactory(HttpJournalRepository(api), HttpInboxCaptureRepository(api), api.changes.events)

    /** [initialDay] is the device's current day, `YYYY-MM-DD`. */
    fun journalViewModel(initialDay: String): JournalViewModel = viewModels.journalViewModel(initialDay)

    fun journalSubpageViewModel(itemId: String): JournalSubpageViewModel =
        viewModels.journalSubpageViewModel(itemId)

    /** The capture row of the diary's Inbox. */
    fun inboxCaptureViewModel(): InboxCaptureViewModel = viewModels.inboxCaptureViewModel()
}
