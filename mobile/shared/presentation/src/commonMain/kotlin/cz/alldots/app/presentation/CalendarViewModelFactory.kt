package cz.alldots.app.presentation

import cz.alldots.app.domain.AnswerInvitation
import cz.alldots.app.domain.CalendarCatalogRepository
import cz.alldots.app.domain.CalendarChanges
import cz.alldots.app.domain.CalendarRepository
import cz.alldots.app.domain.CreateCalendarItem
import cz.alldots.app.domain.EditCalendarEntry
import cz.alldots.app.domain.EditCalendars
import cz.alldots.app.domain.EditSleepNight
import cz.alldots.app.domain.InternetAccountRepository
import cz.alldots.app.domain.InvitationRepository
import cz.alldots.app.domain.LoadCalendarWindow
import cz.alldots.app.domain.SleepRepository
import cz.alldots.app.domain.SyncAccountCalendars
import cz.alldots.app.domain.SyncChanges
import cz.alldots.app.domain.SyncTopic
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.merge
import kotlin.experimental.ExperimentalObjCRefinement
import kotlin.native.HiddenFromObjC

/**
 * Creates the ViewModels of the calendar, whose constructors are internal, for the SDK in the umbrella module. The
 * ViewModels share [changes], so a write made in one of them is read by the others, and follow [sync], so a change
 * the server reports (another device, a synced remote calendar) is read as well. They share one request for the sync
 * of the internet accounts' calendars too, so the calendar and its list together ask at most once a minute. Hidden
 * from Objective-C and Swift so that the domain types it takes stay out of the exported native API.
 */
@OptIn(ExperimentalObjCRefinement::class)
@HiddenFromObjC
class CalendarViewModelFactory(
    private val calendar: CalendarRepository,
    private val catalog: CalendarCatalogRepository,
    private val invitations: InvitationRepository,
    private val changes: CalendarChanges,
    private val accounts: InternetAccountRepository,
    private val dataChanges: Flow<Unit> = emptyFlow(),
    private val sync: SyncChanges = SyncChanges(),
    private val sleep: SleepRepository? = null,
) {
    private val syncAccounts = SyncAccountCalendars(accounts)

    /** One new ViewModel per call; the caller owns it (see [ScreenViewModel]). [initialDay] is `YYYY-MM-DD`. */
    fun calendarViewModel(initialDay: String): CalendarViewModel =
        CalendarViewModel(
            initialDay,
            LoadCalendarWindow(calendar),
            changes,
            EditCalendarEntry(calendar),
            syncAccounts,
            // The calendar shows the number of invitations that wait for an answer, too.
            merge(dataChanges, sync.changes(SyncTopic.CALENDAR), sync.changes(SyncTopic.INVITATIONS)),
            sleep?.let(::EditSleepNight),
        )

    fun calendarListViewModel(): CalendarListViewModel =
        CalendarListViewModel(
            catalog,
            EditCalendars(catalog),
            changes,
            sync.changes(SyncTopic.CALENDAR),
            accounts,
            syncAccounts,
        )

    fun invitationsViewModel(): InvitationsViewModel =
        InvitationsViewModel(invitations, AnswerInvitation(invitations), sync.changes(SyncTopic.INVITATIONS))

    /** [day] is the day the sheet was opened for, `YYYY-MM-DD`. */
    fun newCalendarItemViewModel(day: String): NewCalendarItemViewModel =
        NewCalendarItemViewModel(day, catalog, CreateCalendarItem(calendar))
}
