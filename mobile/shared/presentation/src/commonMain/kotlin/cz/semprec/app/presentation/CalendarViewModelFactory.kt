package cz.semprec.app.presentation

import cz.semprec.app.domain.AnswerInvitation
import cz.semprec.app.domain.CalendarCatalogRepository
import cz.semprec.app.domain.CalendarChanges
import cz.semprec.app.domain.CalendarRepository
import cz.semprec.app.domain.CreateCalendarItem
import cz.semprec.app.domain.EditCalendarEntry
import cz.semprec.app.domain.EditCalendars
import cz.semprec.app.domain.InvitationRepository
import cz.semprec.app.domain.LoadCalendarWindow
import cz.semprec.app.domain.SyncChanges
import cz.semprec.app.domain.SyncTopic
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.merge
import kotlin.experimental.ExperimentalObjCRefinement
import kotlin.native.HiddenFromObjC

/**
 * Creates the ViewModels of the calendar, whose constructors are internal, for the SDK in the umbrella module. The
 * ViewModels share [changes], so a write made in one of them is read by the others, and follow [sync], so a change
 * the server reports (another device, a synced remote calendar) is read as well. Hidden from Objective-C and Swift so
 * that the domain types it takes stay out of the exported native API.
 */
@OptIn(ExperimentalObjCRefinement::class)
@HiddenFromObjC
class CalendarViewModelFactory(
    private val calendar: CalendarRepository,
    private val catalog: CalendarCatalogRepository,
    private val invitations: InvitationRepository,
    private val changes: CalendarChanges,
    private val dataChanges: Flow<Unit> = emptyFlow(),
    private val sync: SyncChanges = SyncChanges(),
) {
    /** One new ViewModel per call; the caller owns it (see [ScreenViewModel]). [initialDay] is `YYYY-MM-DD`. */
    fun calendarViewModel(initialDay: String): CalendarViewModel =
        CalendarViewModel(
            initialDay,
            LoadCalendarWindow(calendar),
            changes,
            EditCalendarEntry(calendar),
            // The calendar shows the number of invitations that wait for an answer, too.
            merge(dataChanges, sync.changes(SyncTopic.CALENDAR), sync.changes(SyncTopic.INVITATIONS)),
        )

    fun calendarListViewModel(): CalendarListViewModel =
        CalendarListViewModel(catalog, EditCalendars(catalog), changes, sync.changes(SyncTopic.CALENDAR))

    fun invitationsViewModel(): InvitationsViewModel =
        InvitationsViewModel(invitations, AnswerInvitation(invitations), sync.changes(SyncTopic.INVITATIONS))

    /** [day] is the day the sheet was opened for, `YYYY-MM-DD`. */
    fun newCalendarItemViewModel(day: String): NewCalendarItemViewModel =
        NewCalendarItemViewModel(day, catalog, CreateCalendarItem(calendar))
}
