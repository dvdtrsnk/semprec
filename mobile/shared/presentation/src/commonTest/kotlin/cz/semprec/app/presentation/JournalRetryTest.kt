package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

/** Reading the shown period again after a write, as the diary does after a capture of its Inbox row. */
@OptIn(ExperimentalCoroutinesApi::class)
class JournalRetryTest : MainDispatcherTest() {
    private val repository = FakeJournalRepository()
    private val changes = MutableSharedFlow<Unit>(extraBufferCapacity = 1)

    private fun viewModel() =
        JournalViewModelFactory(repository, UnusedInboxCaptures, FakeAttachmentFiles(), changes)
            .journalViewModel("2026-10-16")

    private fun reads() = repository.periodCalls.count { it.key == "2026-10-16" }

    private fun withDiary() {
        repository.onPeriod = { content(periodPage(it, markdown = "Morning note", itemId = "item-day")) }
    }

    @Test fun `the write of a capture and the retry after it add the entry in place without loading`() =
        runTest(dispatcher) {
            withDiary()
            val vm = viewModel()
            runCurrent()
            val before = vm.state.value
            val captured = inboxEntry().copy(id = "capture-1", text = "Captured", status = "waiting")
            val gate = CompletableDeferred<Unit>()
            repository.onPeriod = {
                val page = periodPage(it, markdown = "Morning note", itemId = "item-day")
                val answer = if (it.key == "2026-10-16") page.copy(inbox = page.inbox + captured) else page
                repository.late(gate, content(answer))
            }
            changes.emit(Unit)
            runCurrent()
            vm.onAction(JournalAction.Retry)
            runCurrent()
            assertEquals(JournalPhase.CONTENT, vm.state.value.phase)
            assertEquals(before.shown, vm.state.value.shown)
            assertEquals(before.page, vm.state.value.page)
            assertEquals(before.inbox, vm.state.value.inbox)
            gate.complete(Unit)
            runCurrent()
            val after = vm.state.value
            assertEquals(JournalPhase.CONTENT, after.phase)
            assertEquals(before.inbox.map { it.id } + "capture-1", after.inbox.map { it.id })
            assertEquals(before.page, after.page)
            assertEquals(before.events, after.events)
            assertEquals(before.birthdays, after.birthdays)
            assertEquals(before.weeks, after.weeks)
            assertEquals(before.axis, after.axis)
            assertEquals(before.shown, after.shown)
            vm.close()
        }

    @Test fun `a retry after a write over a shown period that cannot be read keeps it shown`() =
        runTest(dispatcher) {
            withDiary()
            val vm = viewModel()
            runCurrent()
            repository.onPeriod = { journalFailure(FailureKind.UNAVAILABLE) }
            changes.emit(Unit)
            runCurrent()
            val before = vm.state.value
            vm.onAction(JournalAction.Retry)
            runCurrent()
            assertEquals(3, reads())
            assertEquals(before, vm.state.value)
            assertEquals(JournalPhase.CONTENT, vm.state.value.phase)
            vm.close()
        }
}
