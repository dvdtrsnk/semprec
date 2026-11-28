package cz.alldots.app.sdk

import cz.alldots.app.data.AuthenticatedApi
import cz.alldots.app.data.HttpCalendarAgendaRepository
import cz.alldots.app.data.HttpCalendarCatalogRepository
import cz.alldots.app.data.HttpCalendarRepository
import cz.alldots.app.data.HttpInvitationRepository
import cz.alldots.app.data.HttpMailboxRepository
import cz.alldots.app.data.HttpSleepRepository
import cz.alldots.app.domain.CalendarChanges
import cz.alldots.app.domain.SyncChanges
import cz.alldots.app.presentation.CalendarAgendaViewModel
import cz.alldots.app.presentation.CalendarAgendaViewModelFactory
import cz.alldots.app.presentation.CalendarListViewModel
import cz.alldots.app.presentation.CalendarViewModel
import cz.alldots.app.presentation.CalendarViewModelFactory
import cz.alldots.app.presentation.InvitationsViewModel
import cz.alldots.app.presentation.NewCalendarItemViewModel

/**
 * The calendar part of [HomeSDK]. Its ViewModels share one change counter, so a calendar hidden, an invitation
 * answered or an item created in one of them is read by the others, and they follow the changes the server reports
 * through [sync]. The calendar and its list also ask the server to sync the internet accounts' calendars. Every call
 * creates a new ViewModel that the caller owns.
 */
class CalendarSDK internal constructor(api: AuthenticatedApi, sync: SyncChanges) {
    private val changes = CalendarChanges()
    private val viewModels = CalendarViewModelFactory(
        HttpCalendarRepository(api, changes),
        HttpCalendarCatalogRepository(api, changes),
        HttpInvitationRepository(api, changes),
        changes,
        HttpMailboxRepository(api),
        api.changes.events,
        sync,
        HttpSleepRepository(api),
    )
    private val agenda = CalendarAgendaViewModelFactory(HttpCalendarAgendaRepository(api), api.changes.events)

    /** [initialDay] is the device's current day, `YYYY-MM-DD`; the first answer of the server names today. */
    fun calendarViewModel(initialDay: String): CalendarViewModel = viewModels.calendarViewModel(initialDay)

    fun calendarListViewModel(): CalendarListViewModel = viewModels.calendarListViewModel()

    fun invitationsViewModel(): InvitationsViewModel = viewModels.invitationsViewModel()

    /** [day] is the day the sheet was opened for, `YYYY-MM-DD`. */
    fun itemFormViewModel(day: String): NewCalendarItemViewModel = viewModels.newCalendarItemViewModel(day)

    /** The calendar as a list from [from] on, `YYYY-MM-DD`. */
    fun calendarAgendaViewModel(from: String): CalendarAgendaViewModel = agenda.calendarAgendaViewModel(from)
}
