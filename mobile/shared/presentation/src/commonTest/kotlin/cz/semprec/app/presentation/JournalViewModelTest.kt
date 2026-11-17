package cz.semprec.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.JournalPeriod
import cz.semprec.app.domain.JournalPeriodType
import cz.semprec.app.domain.PageDocument
import cz.semprec.app.domain.PageWrite
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val DIARY = "Morning **note**\n\n- [ ] Boots\n\n1. one\n1. two\n\n[Trip](semprec://page/jv1)"
private val DAY_REF = JournalPageRef(JournalPeriodKind.DAY, "2026-10-16")

@OptIn(ExperimentalCoroutinesApi::class)
class JournalViewModelTest : MainDispatcherTest() {
    private val repository = FakeJournalRepository()

    private fun viewModel(day: String = "2026-10-16") =
        JournalViewModelFactory(repository, UnusedInboxCaptures).journalViewModel(day)

    private fun TestScope.loaded(day: String = "2026-10-16"): JournalViewModel =
        viewModel(day).also { runCurrent() }

    private fun withDiary() {
        repository.onPeriod = { content(periodPage(it, markdown = DIARY, itemId = "item-day")) }
        repository.onPage = { content(PageDocument(DIARY, "\"v1\"")) }
    }

    @Test fun `starts loading on the given day with the axis around it`() = runTest(dispatcher) {
        val vm = viewModel("2026-10-14")
        val state = vm.state.value
        assertEquals(JournalPhase.LOADING, state.phase)
        assertEquals(JournalSelection(JournalPeriodKind.DAY, "2026-10-14"), state.selection)
        assertEquals(
            listOf(JournalPeriodKind.YEAR, JournalPeriodKind.QUARTER, JournalPeriodKind.MONTH, JournalPeriodKind.DAY),
            state.axis.map {
                it.kind
            }
        )
        assertEquals("2026-10-14", state.axis.last().cells.single { it.current }.start)
        vm.close()
    }

    @Test fun `a day shows its note week events birthdays and inbox`() = runTest(dispatcher) {
        withDiary()
        val vm = loaded()
        val state = vm.state.value
        assertEquals(JournalPhase.CONTENT, state.phase)
        assertEquals("2026-10-16", state.today)
        assertEquals(JournalPageRef(JournalPeriodKind.DAY, "2026-10-16"), state.page?.ref)
        assertEquals(
            listOf(
                JournalBlockKind.TEXT,
                JournalBlockKind.TODO,
                JournalBlockKind.NUMBER,
                JournalBlockKind.NUMBER,
                JournalBlockKind.PAGE,
            ),
            state.page?.blocks?.map { it.kind },
        )
        assertEquals(listOf(0, 0, 1, 2, 0), state.page?.blocks?.map { it.ordinal })
        assertEquals(
            listOf(JournalRun("Morning ", false, false, false, null), JournalRun("note", true, false, false, null)),
            state.page?.blocks?.first()?.runs,
        )
        assertEquals("jv1", state.page?.blocks?.last()?.pageId)
        assertEquals(42, state.weeks.single().number)
        assertEquals("2026-10-12", state.weeks.single().from)
        assertEquals("2026-10-18", state.weeks.single().to)
        val event = state.events.single()
        assertEquals(540, event.startMinutes)
        assertEquals(570, event.endMinutes)
        assertEquals("Semprec iOS", event.projectName)
        assertTrue(event.hasTranscript)
        assertEquals("Jana Kovarova", state.birthdays.single().personName)
        assertEquals(JournalInboxStatus.PROPOSED, state.inbox.single().status)
        assertEquals(2, state.inbox.single().attachmentCount)
        vm.close()
    }

    @Test fun `an all day event has no times`() = runTest(dispatcher) {
        repository.onPeriod = { content(periodPage(it).copy(events = listOf(event().copy(allDay = true)))) }
        val vm = loaded()
        assertNull(vm.state.value.events.single().startMinutes)
        assertNull(vm.state.value.events.single().endMinutes)
        vm.close()
    }

    @Test fun `inbox processing wins over the card status and unknown keys are none`() = runTest(dispatcher) {
        val keys =
            listOf("pending", "failed", "needsClarification", "proposed", "confirmed", "rejected", "invalid", "other")
        repository.onPeriod = {
            content(
                periodPage(it).copy(
                    inbox = keys.mapIndexed { index, key ->
                        inboxEntry().copy(id = "i$index", processing = key, status = "confirmed")
                    },
                ),
            )
        }
        val vm = loaded()
        assertEquals(
            listOf(
                JournalInboxStatus.PENDING, JournalInboxStatus.FAILED, JournalInboxStatus.NEEDS_CLARIFICATION,
                JournalInboxStatus.PROPOSED, JournalInboxStatus.CONFIRMED, JournalInboxStatus.REJECTED,
                JournalInboxStatus.INVALID, JournalInboxStatus.NONE,
            ),
            vm.state.value.inbox.map { it.status },
        )
        vm.close()
    }

    @Test fun `a month lists its weeks and has no page of its own`() = runTest(dispatcher) {
        val vm = loaded()
        vm.onAction(JournalAction.Select(JournalPeriodKind.MONTH, "2026-10-20"))
        runCurrent()
        val state = vm.state.value
        assertEquals(JournalSelection(JournalPeriodKind.MONTH, "2026-10-01"), state.selection)
        assertNull(state.page)
        assertEquals(listOf(40, 41), state.weeks.map { it.number })
        assertEquals(JournalPageRef(JournalPeriodKind.WEEK, "2026-W40"), state.weeks.first().page.ref)
        assertEquals(JournalPeriod(JournalPeriodType.MONTH, "2026-10"), repository.periodCalls.last())
        vm.close()
    }

    @Test fun `a quarter and a year show their own page`() = runTest(dispatcher) {
        val vm = loaded()
        vm.onAction(JournalAction.Select(JournalPeriodKind.QUARTER, "2026-11-05"))
        runCurrent()
        assertEquals(JournalSelection(JournalPeriodKind.QUARTER, "2026-10-01"), vm.state.value.selection)
        assertEquals(JournalPageRef(JournalPeriodKind.QUARTER, "2026-Q4"), vm.state.value.page?.ref)
        vm.onAction(JournalAction.Select(JournalPeriodKind.YEAR, "2026-06-01"))
        runCurrent()
        assertEquals(JournalPageRef(JournalPeriodKind.YEAR, "2026"), vm.state.value.page?.ref)
        assertTrue(vm.state.value.events.isEmpty())
        vm.close()
    }

    @Test fun `selecting the same period or something invalid does not load again`() = runTest(dispatcher) {
        val vm = loaded()
        assertEquals(1, repository.periodCalls.size)
        vm.onAction(JournalAction.Select(JournalPeriodKind.DAY, "2026-10-16"))
        vm.onAction(JournalAction.Select(JournalPeriodKind.DAY, "not a day"))
        vm.onAction(JournalAction.Select(JournalPeriodKind.WEEK, "2026-10-12"))
        runCurrent()
        assertEquals(1, repository.periodCalls.size)
        vm.close()
    }

    @Test fun `moving the axis shifts its windows and keeps the selection and the page`() = runTest(dispatcher) {
        val vm = loaded()
        val before = vm.state.value
        vm.onAction(JournalAction.ShowAxisAround("2029-03-10"))
        runCurrent()
        val after = vm.state.value
        assertEquals(before.selection, after.selection)
        assertEquals(before.page, after.page)
        assertEquals(1, repository.periodCalls.size)
        assertEquals("2028-01-01", after.axis.last().cells.first().start)
        assertEquals("2030-12-31", after.axis.last().cells.last().start)
        assertTrue(after.axis.last().cells.none { it.current })
        assertEquals("2026-01-01", after.axis.first().cells.single { it.onPath }.start)
        vm.onAction(JournalAction.ShowAxisAround("not a day"))
        assertEquals(after.axis, vm.state.value.axis)
        vm.onAction(JournalAction.GoToday)
        runCurrent()
        assertEquals(before.axis, vm.state.value.axis)
        assertEquals(1, repository.periodCalls.size)
        vm.onAction(JournalAction.ShowAxisAround("2029-03-10"))
        vm.onAction(JournalAction.Select(JournalPeriodKind.DAY, "2026-10-17"))
        runCurrent()
        assertEquals("2025-01-01", vm.state.value.axis.last().cells.first().start)
        vm.close()
        vm.onAction(JournalAction.ShowAxisAround("2027-01-01"))
        assertEquals("2025-01-01", vm.state.value.axis.last().cells.first().start)
    }

    @Test fun `the today action selects the day of the server`() = runTest(dispatcher) {
        val vm = loaded("2026-10-01")
        vm.onAction(JournalAction.Select(JournalPeriodKind.DAY, "2026-10-03"))
        runCurrent()
        vm.onAction(JournalAction.GoToday)
        runCurrent()
        assertEquals(JournalSelection(JournalPeriodKind.DAY, "2026-10-16"), vm.state.value.selection)
        assertEquals(JournalPeriod(JournalPeriodType.DAY, "2026-10-16"), repository.periodCalls.last())
        vm.close()
    }

    @Test fun `an invalid initial day falls back and the server day then shows today`() = runTest(dispatcher) {
        val vm = viewModel("garbage")
        assertEquals("2000-01-01", vm.state.value.selection.start)
        runCurrent()
        assertEquals("2026-10-16", vm.state.value.today)
        vm.close()
    }

    @Test fun `a newer selection cancels the older load and the older answer is never shown`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        repository.onPeriod = {
            if (it.key == "2026-10-16") {
                repository.late(gate, content(periodPage(it, markdown = "OLD")))
            } else {
                content(periodPage(it, markdown = "NEW"))
            }
        }
        val vm = viewModel()
        runCurrent()
        vm.onAction(JournalAction.Select(JournalPeriodKind.DAY, "2026-10-17"))
        runCurrent()
        gate.complete(Unit)
        runCurrent()
        assertEquals("NEW", vm.state.value.page?.blocks?.single()?.runs?.single()?.text)
        assertEquals("2026-10-17", vm.state.value.selection.start)
        vm.close()
    }

    @Test fun `a load that never answers is cancelled by the next one`() = runTest(dispatcher) {
        repository.onPeriod = { if (it.key == "2026-10-16") repository.never() else content(periodPage(it)) }
        val vm = viewModel()
        runCurrent()
        vm.onAction(JournalAction.Select(JournalPeriodKind.DAY, "2026-10-17"))
        runCurrent()
        assertEquals(1, repository.cancellations)
        assertEquals(JournalPhase.CONTENT, vm.state.value.phase)
        vm.close()
    }

    @Test fun `an expected failure is an error with its kind and retry recovers`() = runTest(dispatcher) {
        var first = true
        repository.onPeriod = { if (first) journalFailure(FailureKind.UNAUTHORIZED) else content(periodPage(it)) }
        val vm = viewModel()
        runCurrent()
        assertEquals(JournalPhase.ERROR, vm.state.value.phase)
        assertEquals(FailureKind.UNAUTHORIZED, vm.state.value.failure)
        first = false
        vm.onAction(JournalAction.Retry)
        assertEquals(JournalPhase.LOADING, vm.state.value.phase)
        runCurrent()
        assertEquals(JournalPhase.CONTENT, vm.state.value.phase)
        assertNull(vm.state.value.failure)
        vm.close()
    }

    @Test fun `an unexpected exception is an error without a kind`() = runTest(dispatcher) {
        repository.onPeriod = { error("boom") }
        val vm = loaded()
        assertEquals(JournalPhase.ERROR, vm.state.value.phase)
        assertNull(vm.state.value.failure)
        vm.close()
    }

    @Test fun `an answer about another period is invalid data`() = runTest(dispatcher) {
        repository.onPeriod = { content(periodPage(JournalPeriod(JournalPeriodType.DAY, "2026-10-17"))) }
        val vm = loaded()
        assertEquals(FailureKind.INVALID_DATA, vm.state.value.failure)
        vm.close()
    }

    @Test fun `picking a period after a failure loads it`() = runTest(dispatcher) {
        repository.onPeriod = { if (it.key == "2026-10-16") journalFailure() else content(periodPage(it)) }
        val vm = loaded()
        vm.onAction(JournalAction.Select(JournalPeriodKind.DAY, "2026-10-16"))
        runCurrent()
        assertEquals(2, repository.periodCalls.size)
        vm.close()
    }

    @Test fun `opening an event the inbox or a subpage is an effect delivered once`() = runTest(dispatcher) {
        val vm = loaded()
        vm.onAction(JournalAction.OpenEvent("e1"))
        vm.onAction(JournalAction.OpenInbox)
        vm.onAction(JournalAction.OpenPage("jv1", "Trip"))
        val received = mutableListOf<JournalEffect>()
        val collector = launch { vm.effects.collect { received += it } }
        runCurrent()
        collector.cancel()
        assertEquals(
            listOf(JournalEffect.OpenEvent("e1"), JournalEffect.OpenInbox, JournalEffect.OpenPage("jv1", "Trip")),
            received,
        )
        val again = mutableListOf<JournalEffect>()
        val second = launch { vm.effects.collect { again += it } }
        runCurrent()
        second.cancel()
        assertEquals(emptyList(), again)
        vm.close()
    }

    // --- editing ---

    @Test fun `editing a block writes the page the server has and shows the result`() = runTest(dispatcher) {
        withDiary()
        val vm = loaded()
        vm.onAction(JournalAction.SetText(DAY_REF, 0, "Evening note"))
        assertTrue(vm.state.value.saving)
        runCurrent()
        assertFalse(vm.state.value.saving)
        val expected = DIARY.replace("Morning **note**", "Evening **note**")
        assertEquals(Triple("item-day", expected, "\"v1\""), repository.replaced.single())
        assertEquals(JournalRun("note", true, false, false, null), vm.state.value.page?.blocks?.first()?.runs?.last())
        assertEquals(emptyList(), repository.ensureCalls)
        vm.close()
    }

    @Test fun `the first write to an empty period creates its page`() = runTest(dispatcher) {
        repository.onPeriod = { content(periodPage(it, markdown = null, itemId = null)) }
        repository.onPage = { content(PageDocument("", "\"v0\"")) }
        val vm = loaded()
        vm.onAction(JournalAction.AddBlock(DAY_REF, JournalBlockKind.TEXT, "First line"))
        runCurrent()
        assertEquals(listOf(JournalPeriod(JournalPeriodType.DAY, "2026-10-16")), repository.ensureCalls)
        assertEquals(Triple("item-new", "First line", "\"v0\""), repository.replaced.single())
        assertEquals("First line", vm.state.value.page?.blocks?.single()?.runs?.single()?.text)
        vm.onAction(JournalAction.AddBlock(DAY_REF, JournalBlockKind.BULLET, "Second"))
        runCurrent()
        assertEquals(1, repository.ensureCalls.size)
        assertEquals("item-new", repository.replaced.last().first)
        vm.close()
    }

    @Test fun `a week note is edited through its own page`() = runTest(dispatcher) {
        repository.onPeriod = { content(periodPage(it, weekMarkdown = "Week plan", weekItemId = "item-week")) }
        repository.onPage = { content(PageDocument("Week plan", "\"w1\"")) }
        val vm = loaded()
        val weekRef = JournalPageRef(JournalPeriodKind.WEEK, "2026-W42")
        vm.onAction(JournalAction.SetText(weekRef, 0, "Week plan 2"))
        runCurrent()
        assertEquals("item-week", repository.replaced.single().first)
        assertEquals("Week plan 2", vm.state.value.weeks.single().page.blocks.single().runs.single().text)
        vm.close()
    }

    @Test fun `toggling a todo changes its marker`() = runTest(dispatcher) {
        withDiary()
        val vm = loaded()
        vm.onAction(JournalAction.ToggleDone(DAY_REF, 1))
        runCurrent()
        assertTrue(vm.state.value.page?.blocks?.get(1)?.done == true)
        assertTrue(repository.replaced.single().second.contains("- [x] Boots"))
        vm.close()
    }

    @Test fun `changes that cannot apply are ignored without a request`() = runTest(dispatcher) {
        withDiary()
        val vm = loaded()
        vm.onAction(JournalAction.ToggleDone(DAY_REF, 0))
        vm.onAction(JournalAction.SetText(DAY_REF, 4, "x"))
        vm.onAction(JournalAction.SetText(DAY_REF, 9, "x"))
        vm.onAction(JournalAction.SetText(DAY_REF, 0, "Morning note"))
        vm.onAction(JournalAction.AddBlock(DAY_REF, JournalBlockKind.TEXT, "  "))
        vm.onAction(JournalAction.AddBlock(DAY_REF, JournalBlockKind.PAGE, "x"))
        vm.onAction(JournalAction.SetText(JournalPageRef(JournalPeriodKind.DAY, "2020-01-01"), 0, "x"))
        runCurrent()
        assertTrue(repository.replaced.isEmpty())
        assertFalse(vm.state.value.saving)
        vm.close()
    }

    @Test fun `a block that changed on the server makes the edit stale`() = runTest(dispatcher) {
        withDiary()
        repository.onPage = { content(PageDocument("Somebody else wrote this\n\n- [ ] Boots", "\"v9\"")) }
        val vm = loaded()
        vm.onAction(JournalAction.SetText(DAY_REF, 0, "Mine"))
        runCurrent()
        assertEquals(JournalEditProblem.STALE, vm.state.value.editProblem)
        assertFalse(vm.state.value.saving)
        assertTrue(repository.replaced.isEmpty())
        vm.onAction(JournalAction.DismissProblem)
        assertNull(vm.state.value.editProblem)
        vm.close()
    }

    @Test fun `a version conflict at write time makes the edit stale and retry reloads`() = runTest(dispatcher) {
        withDiary()
        repository.onReplace = { _, _, _ -> content(PageWrite.Conflict) }
        val vm = loaded()
        vm.onAction(JournalAction.ToggleDone(DAY_REF, 1))
        runCurrent()
        assertEquals(JournalEditProblem.STALE, vm.state.value.editProblem)
        vm.onAction(JournalAction.Retry)
        runCurrent()
        assertNull(vm.state.value.editProblem)
        assertEquals(2, repository.periodCalls.size)
        vm.close()
    }

    @Test fun `a failed write is a problem with its kind`() = runTest(dispatcher) {
        withDiary()
        repository.onReplace = { _, _, _ -> journalFailure(FailureKind.REJECTED) }
        val vm = loaded()
        vm.onAction(JournalAction.ToggleDone(DAY_REF, 1))
        runCurrent()
        assertEquals(JournalEditProblem.FAILED, vm.state.value.editProblem)
        assertEquals(FailureKind.REJECTED, vm.state.value.editFailure)
        vm.close()
    }

    @Test fun `an unexpected exception while writing is a failed problem without a kind`() = runTest(dispatcher) {
        withDiary()
        repository.onPage = { error("boom") }
        val vm = loaded()
        vm.onAction(JournalAction.ToggleDone(DAY_REF, 1))
        runCurrent()
        assertEquals(JournalEditProblem.FAILED, vm.state.value.editProblem)
        assertNull(vm.state.value.editFailure)
        vm.close()
    }

    @Test fun `a second change while one is written is ignored`() = runTest(dispatcher) {
        withDiary()
        val gate = CompletableDeferred<Unit>()
        repository.onReplace = { _, _, _ -> repository.late(gate, content(PageWrite.Saved("\"v2\""))) }
        val vm = loaded()
        vm.onAction(JournalAction.ToggleDone(DAY_REF, 1))
        runCurrent()
        vm.onAction(JournalAction.SetText(DAY_REF, 0, "Another"))
        runCurrent()
        assertEquals(1, repository.replaced.size)
        gate.complete(Unit)
        runCurrent()
        assertFalse(vm.state.value.saving)
        vm.close()
    }

    @Test fun `a change while the page is loading is ignored`() = runTest(dispatcher) {
        withDiary()
        val vm = viewModel()
        vm.onAction(JournalAction.AddBlock(DAY_REF, JournalBlockKind.TEXT, "too early"))
        runCurrent()
        assertTrue(repository.replaced.isEmpty())
        vm.close()
    }

    @Test fun `selecting another period drops a write in flight`() = runTest(dispatcher) {
        withDiary()
        val gate = CompletableDeferred<Unit>()
        repository.onReplace = { _, _, _ -> repository.late(gate, content(PageWrite.Saved("\"v2\""))) }
        val vm = loaded()
        vm.onAction(JournalAction.ToggleDone(DAY_REF, 1))
        runCurrent()
        vm.onAction(JournalAction.Select(JournalPeriodKind.DAY, "2026-10-17"))
        runCurrent()
        gate.complete(Unit)
        runCurrent()
        assertFalse(vm.state.value.saving)
        assertEquals("2026-10-17", vm.state.value.selection.start)
        vm.close()
    }

    // --- lifetime ---

    @Test fun `closing ends in flight work and ignores actions`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        repository.onPeriod = { repository.late(gate, content(periodPage(it))) }
        val vm = viewModel()
        runCurrent()
        vm.close()
        vm.close()
        gate.complete(Unit)
        runCurrent()
        assertEquals(JournalPhase.LOADING, vm.state.value.phase)
        vm.onAction(JournalAction.Retry)
        vm.onAction(JournalAction.OpenInbox)
        runCurrent()
        assertEquals(1, repository.periodCalls.size)
        assertTrue(vm.isClosed)
    }

    @Test fun `clearing the owning store ends it like close does`() = runTest(dispatcher) {
        val store = ViewModelStore()
        val vm = store.provide { viewModel() }
        runCurrent()
        store.clear()
        assertTrue(vm.isClosed)
        vm.onAction(JournalAction.Retry)
        runCurrent()
        assertEquals(1, repository.periodCalls.size)
    }

    @Test fun `a write elsewhere in the window reads the period again but keeps the page and the axis`() =
        runTest(dispatcher) {
            val changes = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
            withDiary()
            val vm = JournalViewModelFactory(repository, UnusedInboxCaptures, changes).journalViewModel("2026-10-16")
            runCurrent()
            val before = vm.state.value
            repository.onPeriod = {
                content(periodPage(it, markdown = "Changed elsewhere", itemId = "item-day").copy(events = emptyList()))
            }
            changes.emit(Unit)
            runCurrent()
            assertEquals(2, repository.periodCalls.size)
            assertTrue(vm.state.value.events.isEmpty())
            assertEquals(before.inbox, vm.state.value.inbox)
            assertEquals(before.page, vm.state.value.page)
            assertEquals(before.axis, vm.state.value.axis)
            vm.close()
        }

    @Test fun `a write elsewhere while the period is still loading reads nothing more`() = runTest(dispatcher) {
        val changes = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
        val gate = CompletableDeferred<Unit>()
        repository.onPeriod = {
            gate.await()
            content(periodPage(it))
        }
        val vm = JournalViewModelFactory(repository, UnusedInboxCaptures, changes).journalViewModel("2026-10-16")
        runCurrent()
        changes.emit(Unit)
        runCurrent()
        assertEquals(1, repository.periodCalls.size)
        gate.complete(Unit)
        runCurrent()
        assertEquals(JournalPhase.CONTENT, vm.state.value.phase)
        assertEquals(1, repository.periodCalls.size)
        vm.close()
    }
}
