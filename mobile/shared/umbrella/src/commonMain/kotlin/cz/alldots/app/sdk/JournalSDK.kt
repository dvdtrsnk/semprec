package cz.alldots.app.sdk

import cz.alldots.app.data.AuthenticatedApi
import cz.alldots.app.data.FileInboxAttachmentFiles
import cz.alldots.app.data.HttpInboxCaptureRepository
import cz.alldots.app.data.HttpJournalRepository
import cz.alldots.app.presentation.InboxCaptureViewModel
import cz.alldots.app.presentation.JournalViewModel
import cz.alldots.app.presentation.JournalViewModelFactory

/** The diary part of [HomeSDK]. Every call creates a new ViewModel that the caller owns. */
class JournalSDK internal constructor(api: AuthenticatedApi, attachments: FileInboxAttachmentFiles) {
    private val viewModels = JournalViewModelFactory(
        HttpJournalRepository(api),
        HttpInboxCaptureRepository(api),
        attachments,
        api.changes.events,
    )

    /** [initialDay] is the device's current day, `YYYY-MM-DD`. */
    fun journalViewModel(initialDay: String): JournalViewModel = viewModels.journalViewModel(initialDay)

    /** The capture row of the diary's Inbox. */
    fun inboxCaptureViewModel(): InboxCaptureViewModel = viewModels.inboxCaptureViewModel()
}
