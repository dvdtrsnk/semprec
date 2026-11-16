package cz.semprec.app.sdk

import cz.semprec.app.data.AuthenticatedApi
import cz.semprec.app.data.HttpCalendarCatalogRepository
import cz.semprec.app.data.HttpCalendarRepository
import cz.semprec.app.data.HttpInvitationRepository
import cz.semprec.app.domain.CalendarChanges
import cz.semprec.app.presentation.CalendarListViewModel
import cz.semprec.app.presentation.CalendarViewModel
import cz.semprec.app.presentation.CalendarViewModelFactory
import cz.semprec.app.presentation.InvitationsViewModel
import cz.semprec.app.presentation.NewCalendarItemViewModel

/**
 * The calendar part of [HomeSDK]. Its ViewModels share one change counter, so a calendar hidden, an invitation
 * answered or an item created in one of them is read by the others. Every call creates a new ViewModel that the
 * caller owns.
 */
class CalendarSDK internal constructor(api: AuthenticatedApi) {
    private val changes = CalendarChanges()
    private val viewModels = CalendarViewModelFactory(
        HttpCalendarRepository(api, changes),
        HttpCalendarCatalogRepository(api, changes),
        HttpInvitationRepository(api, changes),
        changes,
    )

    /** [initialDay] is the device's current day, `YYYY-MM-DD`; the first answer of the server names today. */
    fun calendarViewModel(initialDay: String): CalendarViewModel = viewModels.calendarViewModel(initialDay)

    fun calendarListViewModel(): CalendarListViewModel = viewModels.calendarListViewModel()

    fun invitationsViewModel(): InvitationsViewModel = viewModels.invitationsViewModel()

    /** [day] is the day the sheet was opened for, `YYYY-MM-DD`. */
    fun newCalendarItemViewModel(day: String): NewCalendarItemViewModel = viewModels.newCalendarItemViewModel(day)
}
