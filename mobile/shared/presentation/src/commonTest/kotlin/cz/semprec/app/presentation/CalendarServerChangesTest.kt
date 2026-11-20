package cz.semprec.app.presentation

import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SyncChanges
import cz.semprec.app.domain.SyncTopic
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

/** The open calendar follows the changes the sync socket reports, as a remote calendar synced by the server. */
@OptIn(ExperimentalCoroutinesApi::class)
class CalendarServerChangesTest : MainDispatcherTest() {
    private val repository = FakeCalendarRepository()
    private val sync = SyncChanges()

    private fun serve(vararg ids: String, pending: Int = 0) {
        val entries = ids.map { entry(it, schedule = schedule("10:00", "11:00")) }
        repository.onWindow = { _, _ -> RepositoryResult.Content(window(entries, pending = pending)) }
    }

    private fun CalendarViewModel.shownIds() = state.value.days.flatMap { it.items }.map { it.id }.toSet()

    private fun windowReads() = repository.calls.count { it == "window" }

    @Test fun `a change the server reports appears in the open calendar without any action`() = runTest(dispatcher) {
        serve("meeting")
        val vm = CalendarViewModelFactory(
            repository,
            FakeCatalogRepository(),
            FakeInvitationRepository(),
            repository.changes,
            sync = sync,
        ).calendarViewModel("2026-10-16")
        runCurrent()
        assertEquals(setOf("meeting"), vm.shownIds())

        serve("meeting", "synced", pending = 2)
        sync.raise(setOf(SyncTopic.MAIL_ACCOUNTS))
        runCurrent()
        assertEquals(1, windowReads())
        assertEquals(setOf("meeting"), vm.shownIds())
        sync.raise(setOf(SyncTopic.CALENDAR))
        runCurrent()
        assertEquals(2, windowReads())
        assertEquals(CalendarPhase.CONTENT, vm.state.value.phase)
        assertEquals(setOf("meeting", "synced"), vm.shownIds())
        assertEquals(2, vm.state.value.pendingInvitations)
        sync.raise(setOf(SyncTopic.INVITATIONS))
        runCurrent()
        assertEquals(3, windowReads())

        vm.close()
        sync.raise(setOf(SyncTopic.CALENDAR))
        runCurrent()
        assertEquals(3, windowReads())
    }
}
