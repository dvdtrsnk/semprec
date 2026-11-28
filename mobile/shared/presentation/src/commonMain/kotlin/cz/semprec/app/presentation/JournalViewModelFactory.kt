package cz.semprec.app.presentation

import cz.semprec.app.domain.InboxAttachmentFiles
import cz.semprec.app.domain.InboxCaptureRepository
import cz.semprec.app.domain.JournalRepository
import cz.semprec.app.domain.LoadJournalPeriod
import cz.semprec.app.domain.OpenInboxAttachment
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlin.experimental.ExperimentalObjCRefinement
import kotlin.native.HiddenFromObjC

/**
 * Creates the diary's ViewModels, whose constructors are internal, for the SDK in the umbrella module. Hidden from
 * Objective-C and Swift so that the domain types it takes stay out of the exported native API.
 */
@OptIn(ExperimentalObjCRefinement::class)
@HiddenFromObjC
class JournalViewModelFactory(
    private val repository: JournalRepository,
    private val captures: InboxCaptureRepository,
    private val attachments: InboxAttachmentFiles,
    private val changes: Flow<Unit> = emptyFlow(),
) {
    /** One new ViewModel per call; the caller owns it (see [ScreenViewModel]). [initialDay] is `YYYY-MM-DD`. */
    fun journalViewModel(initialDay: String): JournalViewModel =
        JournalViewModel(initialDay, LoadJournalPeriod(repository), OpenInboxAttachment(attachments), changes)

    /** One new ViewModel per call; the caller owns it. The capture row of the diary's Inbox. */
    fun inboxCaptureViewModel(): InboxCaptureViewModel = InboxCaptureViewModel(captures)
}
