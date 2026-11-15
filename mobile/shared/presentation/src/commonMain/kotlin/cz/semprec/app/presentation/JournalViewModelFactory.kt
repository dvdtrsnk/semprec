package cz.semprec.app.presentation

import cz.semprec.app.domain.EditJournalPage
import cz.semprec.app.domain.JournalRepository
import cz.semprec.app.domain.LoadJournalPage
import cz.semprec.app.domain.LoadJournalPeriod
import kotlin.experimental.ExperimentalObjCRefinement
import kotlin.native.HiddenFromObjC

/**
 * Creates the diary's ViewModels, whose constructors are internal, for the SDK in the umbrella module. Hidden from
 * Objective-C and Swift so that the domain types it takes stay out of the exported native API.
 */
@OptIn(ExperimentalObjCRefinement::class)
@HiddenFromObjC
class JournalViewModelFactory(private val repository: JournalRepository) {
    /** One new ViewModel per call; the caller owns it (see [ScreenViewModel]). [initialDay] is `YYYY-MM-DD`. */
    fun journalViewModel(initialDay: String): JournalViewModel =
        JournalViewModel(initialDay, LoadJournalPeriod(repository), EditJournalPage(repository))

    /** One new ViewModel per call; the caller owns it (see [ScreenViewModel]). */
    fun journalSubpageViewModel(itemId: String): JournalSubpageViewModel =
        JournalSubpageViewModel(itemId, LoadJournalPage(repository), EditJournalPage(repository))
}
