package cz.alldots.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.alldots.app.core.FailureKind
import cz.alldots.app.domain.JournalPeriod
import cz.alldots.app.domain.JournalPeriodType
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val DIARY = "Morning **note**\n\n- [ ] Boots\n\n1. one\n1. two\n\n[Trip](alldots://page/jv1)"

@OptIn(ExperimentalCoroutinesApi::class)
class JournalViewModelTest : MainDispatcherTest() {
    private val repository = FakeJournalRepository()
    private val attachments = FakeAttachmentFiles()

    private fun factory(changes: Flow<Unit> = emptyFlow()) =
        JournalViewModelFactory(repository, UnusedInboxCaptures, attachments, changes)

    private fun viewModel(day: String = "2026-10-16") = factory().journalViewModel(day)

    private fun TestScope.loaded(day: String = "2026-10-16"): JournalViewModel =
        viewModel(day).also { runCurrent() }

    /** How many times the period [key] was read, its neighbours read in the background aside. */
    private fun reads(key: String = "2026-10-16") = repository.periodCalls.count { it.key == key }

    private fun withDiary() {
        repository.onPeriod = { content(periodPage(it, markdown = DIARY, itemId = "item-day")) }
    }

    @Test fun `starts loading on the given day with the axis around it`() = runTest(dispatcher) {
        val vm = viewModel("2026-10-14")
        val state = vm.state.value
        assertEquals(JournalPhase.LOADING, state.phase)
        assertEquals(JournalSelection(JournalPeriodKind.DAY, "2026-10-14"), state.selection)
        assertEquals(
            listOf(JournalPeriodKind.YEAR, JournalPeriodKind.MONTH, JournalPeriodKind.DAY),
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
        assertEquals("Alldots iOS", event.projectName)
        assertTrue(event.hasTranscript)
        assertEquals("Jana Kovarova", state.birthdays.single().personName)
        assertEquals(JournalInboxStatus.PROPOSED, state.inbox.single().status)
        assertEquals(
            listOf(AttachmentState("a1", "scan.pdf", "application/pdf"), AttachmentState("a2", null, "image/jpeg")),
            state.inbox.single().attachments,
        )
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
            listOf(
                "waiting", "pending", "failed", "needsClarification", "proposed", "confirmed", "rejected", "invalid",
                "other",
            )
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
                JournalInboxStatus.WAITING, JournalInboxStatus.PENDING, JournalInboxStatus.FAILED,
                JournalInboxStatus.NEEDS_CLARIFICATION,
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
        assertEquals(1, reads("2026-10"))
        vm.close()
    }

    @Test fun `a year shows its own page and lists its four quarters`() = runTest(dispatcher) {
        repository.onPeriod = { content(periodPage(it, quarterMarkdown = "Ship it")) }
        val vm = loaded()
        vm.onAction(JournalAction.Select(JournalPeriodKind.YEAR, "2026-06-01"))
        runCurrent()
        val state = vm.state.value
        assertEquals(JournalPageRef(JournalPeriodKind.YEAR, "2026"), state.page?.ref)
        assertEquals(listOf(1, 2, 3, 4), state.quarters.map { it.number })
        val fourth = state.quarters.last()
        assertEquals("2026-10-01", fourth.from)
        assertEquals("2026-12-31", fourth.to)
        assertEquals(JournalPageRef(JournalPeriodKind.QUARTER, "2026-Q4"), fourth.page.ref)
        assertEquals(listOf(JournalBlockKind.TEXT), fourth.page.blocks.map { it.kind })
        assertTrue(state.events.isEmpty())
        assertTrue(state.weeks.isEmpty())
        vm.onAction(JournalAction.Select(JournalPeriodKind.MONTH, "2026-10-01"))
        runCurrent()
        assertTrue(vm.state.value.quarters.isEmpty())
        vm.close()
    }

    @Test fun `selecting the same period or something invalid does not load again`() = runTest(dispatcher) {
        val vm = loaded()
        assertEquals(1, reads())
        vm.onAction(JournalAction.Select(JournalPeriodKind.DAY, "2026-10-16"))
        vm.onAction(JournalAction.Select(JournalPeriodKind.DAY, "not a day"))
        vm.onAction(JournalAction.Select(JournalPeriodKind.WEEK, "2026-10-12"))
        vm.onAction(JournalAction.Select(JournalPeriodKind.QUARTER, "2026-10-01"))
        runCurrent()
        assertEquals(1, reads())
        assertEquals(JournalSelection(JournalPeriodKind.DAY, "2026-10-16"), vm.state.value.selection)
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
        assertEquals(1, reads())
        assertEquals("2027-01-01", after.axis.last().cells.first().start)
        assertEquals("2031-12-31", after.axis.last().cells.last().start)
        assertTrue(after.axis.last().cells.none { it.current })
        assertTrue(after.axis.first().cells.none { it.onPath })
        vm.onAction(JournalAction.ShowAxisAround("not a day"))
        assertEquals(after.axis, vm.state.value.axis)
        vm.onAction(JournalAction.GoToday)
        runCurrent()
        assertEquals(before.axis, vm.state.value.axis)
        assertEquals(1, reads())
        vm.onAction(JournalAction.ShowAxisAround("2029-03-10"))
        vm.onAction(JournalAction.Select(JournalPeriodKind.DAY, "2026-10-17"))
        runCurrent()
        assertEquals("2024-01-01", vm.state.value.axis.last().cells.first().start)
        vm.close()
        vm.onAction(JournalAction.ShowAxisAround("2027-01-01"))
        assertEquals("2024-01-01", vm.state.value.axis.last().cells.first().start)
    }

    @Test fun `a selection inside the windows keeps them while it loads and after`() = runTest(dispatcher) {
        val vm = loaded()
        vm.onAction(JournalAction.ShowAxisAround("2027-06-01"))
        runCurrent()
        val windows = vm.state.value.axis.map { row -> row.cells.map { it.start } }
        assertEquals("2025-01-01", windows.last().first())
        vm.onAction(JournalAction.Select(JournalPeriodKind.MONTH, "2026-03-01"))
        assertEquals(windows, vm.state.value.axis.map { row -> row.cells.map { it.start } })
        runCurrent()
        assertEquals(JournalPhase.CONTENT, vm.state.value.phase)
        assertEquals(windows, vm.state.value.axis.map { row -> row.cells.map { it.start } })
        assertEquals("2026-03-01", vm.state.value.axis[1].cells.single { it.current }.start)
        vm.onAction(JournalAction.Select(JournalPeriodKind.YEAR, "2024-01-01"))
        runCurrent()
        assertEquals("2022-01-01", vm.state.value.axis.last().cells.first().start)
        vm.close()
    }

    // --- neighbours read ahead ---

    @Test fun `a shown period has the period before and after it read in the background`() = runTest(dispatcher) {
        val vm = loaded()
        assertEquals(1, reads("2026-10-17"))
        assertEquals(1, reads("2026-10-15"))
        vm.onAction(JournalAction.Select(JournalPeriodKind.MONTH, "2026-10-01"))
        runCurrent()
        assertEquals(1, reads("2026-11"))
        assertEquals(1, reads("2026-09"))
        vm.onAction(JournalAction.Select(JournalPeriodKind.YEAR, "2026-01-01"))
        runCurrent()
        assertEquals(1, reads("2027"))
        assertEquals(1, reads("2025"))
        vm.close()
    }

    @Test fun `a neighbour that cannot be read is left out and the other one is still kept`() = runTest(dispatcher) {
        repository.onPeriod = {
            if (it.key == "2026-10-17") journalFailure() else content(periodPage(it, markdown = "PAGE ${it.key}"))
        }
        val vm = loaded()
        assertNull(vm.state.value.after)
        assertEquals(JournalSelection(JournalPeriodKind.DAY, "2026-10-15"), vm.state.value.before?.shown)
        assertEquals(JournalPhase.CONTENT, vm.state.value.phase)
        assertNull(vm.state.value.failure)
        vm.onAction(JournalAction.Select(JournalPeriodKind.DAY, "2026-10-15"))
        runCurrent()
        assertEquals("PAGE 2026-10-15", vm.state.value.page?.blocks?.single()?.runs?.single()?.text)
        // Read ahead once, then once more behind the kept page shown at once.
        assertEquals(2, reads("2026-10-15"))
        vm.close()
    }

    @Test fun `a neighbour whose read throws is left out and the other one is still kept`() = runTest(dispatcher) {
        repository.onPeriod = {
            if (it.key == "2026-10-15") error("broken") else content(periodPage(it))
        }
        val vm = loaded()
        assertNull(vm.state.value.before)
        assertEquals(JournalSelection(JournalPeriodKind.DAY, "2026-10-17"), vm.state.value.after?.shown)
        assertEquals(JournalPhase.CONTENT, vm.state.value.phase)
        vm.close()
    }

    @Test fun `a period read ahead shows at once and its own answer then replaces it`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        repository.onPeriod = {
            if (it.key == "2026-10-17" && reads("2026-10-17") > 1) {
                repository.late(gate, content(periodPage(it, markdown = "FRESH")))
            } else {
                content(periodPage(it, markdown = "KEPT ${it.key}"))
            }
        }
        val vm = loaded()
        vm.onAction(JournalAction.Select(JournalPeriodKind.DAY, "2026-10-17"))
        runCurrent()
        assertEquals(JournalPhase.CONTENT, vm.state.value.phase)
        assertEquals(JournalSelection(JournalPeriodKind.DAY, "2026-10-17"), vm.state.value.shown)
        assertEquals("KEPT 2026-10-17", vm.state.value.page?.blocks?.single()?.runs?.single()?.text)
        gate.complete(Unit)
        runCurrent()
        assertEquals("FRESH", vm.state.value.page?.blocks?.single()?.runs?.single()?.text)
        assertEquals(1, reads("2026-10-18"))
        vm.close()
    }

    @Test fun `a period read ahead stays shown when it cannot be read again`() = runTest(dispatcher) {
        repository.onPeriod = {
            if (it.key == "2026-10-17" && reads("2026-10-17") > 1) journalFailure() else content(periodPage(it))
        }
        val vm = loaded()
        vm.onAction(JournalAction.Select(JournalPeriodKind.DAY, "2026-10-17"))
        runCurrent()
        assertEquals(JournalPhase.CONTENT, vm.state.value.phase)
        assertEquals(JournalSelection(JournalPeriodKind.DAY, "2026-10-17"), vm.state.value.shown)
        assertNull(vm.state.value.failure)
        vm.close()
    }

    @Test fun `a write elsewhere reads the periods ahead again`() = runTest(dispatcher) {
        val changes = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
        repository.onPeriod = { content(periodPage(it, markdown = "BEFORE")) }
        val vm = factory(changes).journalViewModel("2026-10-16")
        runCurrent()
        repository.onPeriod = { content(periodPage(it, markdown = "AFTER")) }
        changes.emit(Unit)
        runCurrent()
        assertEquals(2, reads("2026-10-17"))
        val gate = CompletableDeferred<Unit>()
        repository.onPeriod = { repository.late(gate, content(periodPage(it, markdown = "LATER"))) }
        vm.onAction(JournalAction.Select(JournalPeriodKind.DAY, "2026-10-17"))
        runCurrent()
        assertEquals("AFTER", vm.state.value.page?.blocks?.single()?.runs?.single()?.text)
        gate.complete(Unit)
        runCurrent()
        vm.close()
    }

    @Test fun `the periods read ahead lie beside the shown one once they are read`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        repository.onPeriod = {
            when (it.key) {
                "2026-10-15" -> repository.late(gate, content(periodPage(it, markdown = "BEFORE")))
                else -> content(periodPage(it, markdown = "PAGE ${it.key}"))
            }
        }
        val vm = loaded()
        val after = vm.state.value.after
        assertEquals(JournalSelection(JournalPeriodKind.DAY, "2026-10-17"), after?.shown)
        assertEquals("PAGE 2026-10-17", after?.page?.blocks?.single()?.runs?.single()?.text)
        assertNull(vm.state.value.before)
        gate.complete(Unit)
        runCurrent()
        assertEquals(JournalSelection(JournalPeriodKind.DAY, "2026-10-15"), vm.state.value.before?.shown)
        assertEquals("BEFORE", vm.state.value.before?.page?.blocks?.single()?.runs?.single()?.text)
        vm.close()
    }

    @Test fun `a month or a year has the months or years beside it`() = runTest(dispatcher) {
        val vm = loaded()
        vm.onAction(JournalAction.Select(JournalPeriodKind.MONTH, "2026-10-01"))
        runCurrent()
        assertEquals(JournalSelection(JournalPeriodKind.MONTH, "2026-09-01"), vm.state.value.before?.shown)
        assertEquals(JournalSelection(JournalPeriodKind.MONTH, "2026-11-01"), vm.state.value.after?.shown)
        assertNull(vm.state.value.after?.page)
        vm.onAction(JournalAction.Select(JournalPeriodKind.YEAR, "2026-01-01"))
        runCurrent()
        assertEquals(JournalSelection(JournalPeriodKind.YEAR, "2025-01-01"), vm.state.value.before?.shown)
        assertEquals(JournalPageRef(JournalPeriodKind.YEAR, "2027"), vm.state.value.after?.page?.ref)
        vm.close()
    }

    @Test fun `a new selection keeps the neighbours of the period still shown`() = runTest(dispatcher) {
        val vm = loaded()
        val gate = CompletableDeferred<Unit>()
        repository.onPeriod = { repository.late(gate, content(periodPage(it))) }
        vm.onAction(JournalAction.Select(JournalPeriodKind.DAY, "2026-10-20"))
        runCurrent()
        assertEquals(JournalSelection(JournalPeriodKind.DAY, "2026-10-16"), vm.state.value.shown)
        assertEquals(JournalSelection(JournalPeriodKind.DAY, "2026-10-17"), vm.state.value.after?.shown)
        gate.complete(Unit)
        runCurrent()
        assertEquals(JournalSelection(JournalPeriodKind.DAY, "2026-10-21"), vm.state.value.after?.shown)
        vm.close()
    }

    @Test fun `a period loading after a failure has nothing beside it`() = runTest(dispatcher) {
        repository.onPeriod = { journalFailure() }
        val vm = loaded()
        assertNull(vm.state.value.before)
        assertNull(vm.state.value.after)
        vm.close()
    }

    @Test fun `a write elsewhere drops the periods beside the shown one until they are read again`() =
        runTest(dispatcher) {
            val changes = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
            val vm = factory(changes).journalViewModel("2026-10-16")
            runCurrent()
            val gate = CompletableDeferred<Unit>()
            repository.onPeriod = { repository.late(gate, content(periodPage(it))) }
            changes.emit(Unit)
            runCurrent()
            assertNull(vm.state.value.before)
            assertNull(vm.state.value.after)
            gate.complete(Unit)
            runCurrent()
            assertEquals(JournalSelection(JournalPeriodKind.DAY, "2026-10-17"), vm.state.value.after?.shown)
            vm.close()
        }

    @Test fun `a period being read ahead when a write lands elsewhere is not kept`() = runTest(dispatcher) {
        val changes = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
        val gate = CompletableDeferred<Unit>()
        repository.onPeriod = {
            when (it.key) {
                "2026-10-16" -> content(periodPage(it))
                else -> repository.late(gate, content(periodPage(it, markdown = "BEFORE THE WRITE")))
            }
        }
        val vm = factory(changes).journalViewModel("2026-10-16")
        runCurrent()
        // The shown period is read again slowly, so the read ahead that began before the write ends first.
        val reread = CompletableDeferred<Unit>()
        repository.onPeriod = {
            val answer = content(periodPage(it, markdown = "AFTER THE WRITE"))
            if (it.key == "2026-10-16") repository.late(reread, answer) else answer
        }
        changes.emit(Unit)
        runCurrent()
        gate.complete(Unit)
        runCurrent()
        reread.complete(Unit)
        runCurrent()
        assertEquals("AFTER THE WRITE", vm.state.value.after?.page?.blocks?.single()?.runs?.single()?.text)
        assertEquals("AFTER THE WRITE", vm.state.value.before?.page?.blocks?.single()?.runs?.single()?.text)
        vm.close()
    }

    @Test fun `a turn selects the period of the same kind that many steps away`() = runTest(dispatcher) {
        val vm = loaded("2026-12-31")
        vm.onAction(JournalAction.Turn(1))
        assertEquals(JournalSelection(JournalPeriodKind.DAY, "2027-01-01"), vm.state.value.selection)
        vm.onAction(JournalAction.Select(JournalPeriodKind.MONTH, "2027-01-01"))
        vm.onAction(JournalAction.Turn(-1))
        assertEquals(JournalSelection(JournalPeriodKind.MONTH, "2026-12-01"), vm.state.value.selection)
        vm.onAction(JournalAction.Select(JournalPeriodKind.YEAR, "2026-01-01"))
        vm.onAction(JournalAction.Turn(-3))
        assertEquals(JournalSelection(JournalPeriodKind.YEAR, "2023-01-01"), vm.state.value.selection)
        runCurrent()
        assertEquals(1, reads("2023"))
        vm.close()
    }

    @Test fun `a turn by no steps selects the same period and reads nothing again`() = runTest(dispatcher) {
        val vm = loaded()
        vm.onAction(JournalAction.Turn(0))
        runCurrent()
        assertEquals(JournalSelection(JournalPeriodKind.DAY, "2026-10-16"), vm.state.value.selection)
        assertEquals(1, reads())
        vm.close()
    }

    @Test fun `the today action selects the day of the server`() = runTest(dispatcher) {
        val vm = loaded("2026-10-01")
        vm.onAction(JournalAction.Select(JournalPeriodKind.DAY, "2026-10-03"))
        runCurrent()
        vm.onAction(JournalAction.GoToday)
        runCurrent()
        assertEquals(JournalSelection(JournalPeriodKind.DAY, "2026-10-16"), vm.state.value.selection)
        assertEquals(1, reads("2026-10-16"))
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

    @Test fun `a new selection keeps the shown period until its own arrives`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        repository.onPeriod = {
            if (it.key == "2026-10-17") {
                repository.late(gate, content(periodPage(it, markdown = "NEW")))
            } else {
                content(periodPage(it, markdown = "OLD"))
            }
        }
        val vm = viewModel()
        runCurrent()
        vm.onAction(JournalAction.Select(JournalPeriodKind.DAY, "2026-10-17"))
        runCurrent()
        val waiting = vm.state.value
        assertEquals(JournalPhase.CONTENT, waiting.phase)
        assertEquals("OLD", waiting.page?.blocks?.single()?.runs?.single()?.text)
        assertEquals("2026-10-17", waiting.selection.start)
        assertEquals("2026-10-17", waiting.axis.last().cells.single { it.current }.start)
        assertEquals(JournalSelection(JournalPeriodKind.DAY, "2026-10-16"), waiting.shown)
        gate.complete(Unit)
        runCurrent()
        assertEquals("NEW", vm.state.value.page?.blocks?.single()?.runs?.single()?.text)
        assertEquals(JournalSelection(JournalPeriodKind.DAY, "2026-10-17"), vm.state.value.shown)
        vm.close()
    }

    @Test fun `a new selection after a failure shows it loading`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        repository.onPeriod = {
            if (it.key == "2026-10-16") journalFailure() else repository.late(gate, content(periodPage(it)))
        }
        val vm = loaded()
        assertEquals(JournalPhase.ERROR, vm.state.value.phase)
        vm.onAction(JournalAction.Select(JournalPeriodKind.DAY, "2026-10-17"))
        runCurrent()
        assertEquals(JournalPhase.LOADING, vm.state.value.phase)
        assertNull(vm.state.value.shown)
        gate.complete(Unit)
        runCurrent()
        assertEquals(JournalPhase.CONTENT, vm.state.value.phase)
        assertEquals(JournalSelection(JournalPeriodKind.DAY, "2026-10-17"), vm.state.value.shown)
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
        assertEquals(2, reads())
        vm.close()
    }

    @Test fun `opening an event or the inbox is an effect delivered once`() = runTest(dispatcher) {
        val vm = loaded()
        vm.onAction(JournalAction.OpenEvent("e1"))
        vm.onAction(JournalAction.OpenInbox)
        val received = mutableListOf<JournalEffect>()
        val collector = launch { vm.effects.collect { received += it } }
        runCurrent()
        collector.cancel()
        assertEquals(listOf(JournalEffect.OpenEvent("e1"), JournalEffect.OpenInbox), received)
        val again = mutableListOf<JournalEffect>()
        val second = launch { vm.effects.collect { again += it } }
        runCurrent()
        second.cancel()
        assertEquals(emptyList(), again)
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
        assertEquals(1, reads())
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
        assertEquals(1, reads())
    }

    @Test fun `a write elsewhere in the window reads the period again but keeps the page and the axis`() =
        runTest(dispatcher) {
            val changes = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
            withDiary()
            val vm = factory(changes).journalViewModel("2026-10-16")
            runCurrent()
            val before = vm.state.value
            repository.onPeriod = {
                content(periodPage(it, markdown = "Changed elsewhere", itemId = "item-day").copy(events = emptyList()))
            }
            changes.emit(Unit)
            runCurrent()
            assertEquals(2, reads())
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
        val vm = factory(changes).journalViewModel("2026-10-16")
        runCurrent()
        changes.emit(Unit)
        runCurrent()
        assertEquals(1, reads())
        gate.complete(Unit)
        runCurrent()
        assertEquals(JournalPhase.CONTENT, vm.state.value.phase)
        assertEquals(1, reads())
        vm.close()
    }
}
