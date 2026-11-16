package cz.semprec.app.sdk

import cz.semprec.app.core.FailureKind
import cz.semprec.app.presentation.CalendarListPhase
import cz.semprec.app.presentation.CalendarPhase
import cz.semprec.app.presentation.InvitationsPhase
import cz.semprec.app.presentation.NewItemPhase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotSame

@OptIn(ExperimentalCoroutinesApi::class)
class CalendarSDKTest {
    private val dispatcher = StandardTestDispatcher()

    @BeforeTest fun installMain() = Dispatchers.setMain(dispatcher)

    @AfterTest fun removeMain() = Dispatchers.resetMain()

    @Test fun `every calendar call returns a new ViewModel that its caller owns`() = runTest(dispatcher) {
        val sdk = HomeSDK().calendar
        val calendars = sdk.calendarViewModel("2026-10-16") to sdk.calendarViewModel("2026-10-16")
        val lists = sdk.calendarListViewModel() to sdk.calendarListViewModel()
        val invitations = sdk.invitationsViewModel() to sdk.invitationsViewModel()
        val forms = sdk.itemFormViewModel("2026-10-16") to sdk.itemFormViewModel("2026-10-16")
        assertNotSame(calendars.first, calendars.second)
        assertNotSame(lists.first, lists.second)
        assertNotSame(invitations.first, invitations.second)
        assertNotSame(forms.first, forms.second)
        listOf(calendars.first, calendars.second).forEach { it.close() }
        listOf(lists.first, lists.second).forEach { it.close() }
        listOf(invitations.first, invitations.second).forEach { it.close() }
        listOf(forms.first, forms.second).forEach { it.close() }
    }

    @Test fun `without a session the calendar fails as unauthorized without a request`() = runTest(dispatcher) {
        val sdk = HomeSDK().calendar
        val calendar = sdk.calendarViewModel("2026-10-16")
        val list = sdk.calendarListViewModel()
        val invitations = sdk.invitationsViewModel()
        val form = sdk.itemFormViewModel("2026-10-16")
        runCurrent()
        assertEquals(CalendarPhase.ERROR, calendar.state.value.phase)
        assertEquals(FailureKind.UNAUTHORIZED, calendar.state.value.failure)
        assertEquals(CalendarListPhase.ERROR, list.state.value.phase)
        assertEquals(InvitationsPhase.ERROR, invitations.state.value.phase)
        assertEquals(NewItemPhase.EDITING, form.state.value.phase)
        calendar.close()
        list.close()
        invitations.close()
        form.close()
    }
}
