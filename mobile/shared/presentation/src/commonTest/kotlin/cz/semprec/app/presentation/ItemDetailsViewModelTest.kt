package cz.semprec.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.semprec.app.core.EntityRef
import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.ItemKind
import cz.semprec.app.core.LinkState
import cz.semprec.app.core.LinkedValue
import cz.semprec.app.core.TaskRepeat
import cz.semprec.app.core.TaskStatus
import cz.semprec.app.core.ValueLink
import cz.semprec.app.domain.ItemChange
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.Schedule
import cz.semprec.app.domain.WorkItem
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class ItemDetailsViewModelTest : MainDispatcherTest() {
    private val fake = FakeWork()
    private val karel = EntityRef("u1", "Karel")

    private val invoice = aTask("t1", from = "14:00", project = WORK_PROJECT, flagged = true).copy(
        title = "Odeslat fakturu",
        description = "Za září",
        schedule = Schedule(WORK_TODAY, "14:00", "15:30"),
        repeat = TaskRepeat.DAILY,
        people = listOf(karel),
        files = listOf(EntityRef("f1", "Faktura.pdf")),
        hostEvents = listOf(EntityRef("e1", "Zubař")),
        projectLink = ValueLink(LinkState.INHERITED, "Schůzka"),
        peopleLink = ValueLink(LinkState.BROKEN, "Schůzka", brokenBySemp = true),
    )
    private val meeting = invoice.copy(
        kind = ItemKind.EVENT,
        id = "e1",
        place = "Kancelář",
        company = EntityRef("c1", "Novák Web"),
        status = TaskStatus.NOT_DONE,
    )

    private fun task(item: WorkItem = invoice) {
        fake.onLoad = { _, _ -> RepositoryResult.Content(item) }
    }

    private fun sheet(kind: ItemKind = ItemKind.TASK, id: String = "t1") = fake.factory().itemDetailsViewModel(kind, id)

    @Test fun `a task is shown with everything it has`() = runTest(dispatcher) {
        task()
        val vm = sheet()
        assertEquals(ItemDetailsPhase.LOADING, vm.state.value.phase)
        runCurrent()

        val state = vm.state.value
        assertEquals(ItemDetailsPhase.CONTENT, state.phase)
        assertEquals(ItemKind.TASK, state.kind)
        assertEquals("Odeslat fakturu", state.title)
        assertFalse(state.done)
        assertEquals("Za září", state.description)
        assertTrue(state.flagged)
        assertEquals(WORK_TODAY, state.date)
        assertEquals("14:00", state.timeFrom)
        assertEquals("15:30", state.timeTo)
        assertEquals(90, state.lengthMinutes)
        assertFalse(state.allDay)
        assertEquals(TaskRepeat.DAILY, state.repeat)
        assertEquals("Semprec iOS", state.project?.title)
        assertEquals(listOf(karel), state.people)
        assertEquals(listOf("Faktura.pdf"), state.files.map { it.title })
        assertEquals(listOf("Zubař"), state.hostEvents.map { it.title })
        assertEquals(LinkState.INHERITED, state.projectLink?.state)
        assertTrue(state.peopleLink?.brokenBySemp == true)
        vm.close()
    }

    @Test fun `an event without a start time is all day and shows its place and company`() = runTest(dispatcher) {
        task(meeting.copy(schedule = Schedule(WORK_TODAY, null, null, "2026-10-18")))
        val vm = sheet(ItemKind.EVENT, "e1")
        runCurrent()

        val state = vm.state.value
        assertTrue(state.allDay)
        assertEquals("Kancelář", state.place)
        assertEquals("Novák Web", state.company?.title)
        assertEquals("2026-10-18", state.endDate)
        assertNull(state.lengthMinutes)
        vm.close()
    }

    @Test fun `a failed load is an error and retry loads again`() = runTest(dispatcher) {
        val vm = sheet()
        runCurrent()
        assertEquals(ItemDetailsPhase.ERROR, vm.state.value.phase)
        assertEquals(FailureKind.NOT_FOUND, vm.state.value.failure)

        task()
        vm.onAction(ItemDetailsAction.Retry)
        assertEquals(ItemDetailsPhase.LOADING, vm.state.value.phase)
        runCurrent()
        assertEquals(ItemDetailsPhase.CONTENT, vm.state.value.phase)
        assertNull(vm.state.value.failure)
        vm.close()
    }

    @Test fun `an unexpected exception while loading is unavailable`() = runTest(dispatcher) {
        fake.onLoad = { _, _ -> error("boom") }
        val vm = sheet()
        runCurrent()

        assertEquals(FailureKind.UNAVAILABLE, vm.state.value.failure)
        vm.close()
    }

    @Test fun `a title is written trimmed and a blank one is not written`() = runTest(dispatcher) {
        task()
        val vm = sheet()
        runCurrent()

        vm.onAction(ItemDetailsAction.SetTitle("   "))
        runCurrent()
        assertTrue(fake.updates.isEmpty())
        vm.onAction(ItemDetailsAction.SetTitle(" Nový "))
        assertEquals("Nový", vm.state.value.title)
        runCurrent()

        assertEquals(ItemChange.Title("Nový"), fake.updates.single().second)
        assertEquals("v1", fake.updates.single().first.version)
        vm.close()
    }

    @Test fun `ticking the task off shows at once and tells the open lists`() = runTest(dispatcher) {
        task()
        val vm = sheet()
        runCurrent()
        val announced = mutableListOf<Unit>()
        val listener = launch { fake.changes.events.collect { announced += it } }
        runCurrent()
        fake.onUpdate = { item, _ -> RepositoryResult.Content(item.copy(status = TaskStatus.DONE, version = "v2")) }

        vm.onAction(ItemDetailsAction.ToggleDone)
        assertTrue(vm.state.value.done)
        runCurrent()

        assertEquals(ItemChange.Done(true), fake.updates.single().second)
        assertEquals(1, announced.size)
        assertTrue(vm.state.value.done)
        listener.cancel()
        vm.close()
    }

    @Test fun `text and flag edits are written as they are`() = runTest(dispatcher) {
        task(meeting)
        val vm = sheet(ItemKind.EVENT, "e1")
        runCurrent()

        vm.onAction(ItemDetailsAction.SetDescription("Nový popis"))
        vm.onAction(ItemDetailsAction.SetPlace("Praha"))
        vm.onAction(ItemDetailsAction.SetFlagged(false))
        vm.onAction(ItemDetailsAction.SetRepeat(TaskRepeat.WEEKLY))
        runCurrent()

        assertEquals(
            listOf(
                ItemChange.Description("Nový popis"),
                ItemChange.Place("Praha"),
                ItemChange.Flagged(false),
                ItemChange.Repeat(TaskRepeat.WEEKLY),
            ),
            fake.updates.map { it.second },
        )
        vm.close()
    }

    @Test fun `the schedule rules of a task`() = runTest(dispatcher) {
        task()
        val vm = sheet()
        runCurrent()
        fun changes() = fake.updates.map { (it.second as ItemChange.Reschedule).schedule }

        vm.onAction(ItemDetailsAction.SetTimeFrom("16:00"))
        runCurrent()
        vm.onAction(ItemDetailsAction.SetTimeTo("10:00"))
        runCurrent()
        vm.onAction(ItemDetailsAction.SetEnded(false))
        runCurrent()
        vm.onAction(ItemDetailsAction.SetTimed(false))
        runCurrent()
        vm.onAction(ItemDetailsAction.SetDate(null))
        runCurrent()

        // The fake answers each write with the item as the write left it, so each edit builds on the one before.
        assertEquals(
            listOf(
                Schedule(WORK_TODAY, "16:00", "17:30"),
                Schedule(WORK_TODAY, "16:00", "16:05"),
                Schedule(WORK_TODAY, "16:00", null),
                Schedule(WORK_TODAY, null, null),
                Schedule(null, null, null),
            ),
            changes(),
        )
        vm.close()
    }

    @Test fun `an unchanged schedule is not written and the switches turn on their defaults`() = runTest(dispatcher) {
        task(invoice.copy(schedule = Schedule(WORK_TODAY, null, null)))
        val vm = sheet()
        runCurrent()

        vm.onAction(ItemDetailsAction.SetTimed(false))
        vm.onAction(ItemDetailsAction.SetEnded(true))
        vm.onAction(ItemDetailsAction.SetAllDay(true))
        runCurrent()
        assertTrue(fake.updates.isEmpty(), "Nothing to turn off, no end without a start, no all day for a task")

        vm.onAction(ItemDetailsAction.SetTimed(true))
        vm.onAction(ItemDetailsAction.SetDate("2026-10-20"))
        runCurrent()
        assertEquals(
            listOf(Schedule(WORK_TODAY, "09:00", null), Schedule("2026-10-20", "09:00", null)),
            fake.updates.map { (it.second as ItemChange.Reschedule).schedule },
        )
        vm.close()
    }

    @Test fun `an event keeps its day and switches between all day and an hour from nine`() = runTest(dispatcher) {
        task(meeting)
        val vm = sheet(ItemKind.EVENT, "e1")
        runCurrent()

        vm.onAction(ItemDetailsAction.SetDate(null))
        vm.onAction(ItemDetailsAction.SetAllDay(true))
        vm.onAction(ItemDetailsAction.SetDate("2026-10-17"))
        runCurrent()

        assertEquals(
            listOf(Schedule(WORK_TODAY, null, null), Schedule("2026-10-17", null, null)),
            fake.updates.map { (it.second as ItemChange.Reschedule).schedule },
        )
        vm.close()
    }

    @Test fun `every write names the version the one before it produced`() = runTest(dispatcher) {
        task()
        val vm = sheet()
        runCurrent()
        val gate = CompletableDeferred<Unit>()
        var version = 1
        fake.onUpdate = { item, _ ->
            if (version == 1) gate.await()
            version += 1
            RepositoryResult.Content(item.copy(version = "v$version"))
        }

        vm.onAction(ItemDetailsAction.SetFlagged(false))
        vm.onAction(ItemDetailsAction.SetPlace("A"))
        runCurrent()
        assertEquals(1, fake.updates.size, "The second write waits for the first")
        gate.complete(Unit)
        runCurrent()

        assertEquals(listOf("v1", "v2"), fake.updates.map { it.first.version })
        assertEquals("A", vm.state.value.place)
        assertFalse(vm.state.value.flagged)
        vm.close()
    }

    @Test fun `a refused write shows a notice and the server's item again`() = runTest(dispatcher) {
        task()
        val vm = sheet()
        runCurrent()
        fake.onUpdate = { _, _ -> RepositoryResult.Failure(FailureKind.REJECTED) }

        vm.onAction(ItemDetailsAction.SetTitle("Jiný"))
        assertEquals("Jiný", vm.state.value.title)
        runCurrent()

        assertEquals("Odeslat fakturu", vm.state.value.title)
        assertEquals(FailureKind.REJECTED, vm.state.value.notice)
        vm.onAction(ItemDetailsAction.DismissNotice)
        assertNull(vm.state.value.notice)
        vm.close()
    }

    @Test fun `an unexpected exception in a write is an unavailable notice`() = runTest(dispatcher) {
        task()
        val vm = sheet()
        runCurrent()
        fake.onUpdate = { _, _ -> error("boom") }

        vm.onAction(ItemDetailsAction.SetPlace("X"))
        runCurrent()

        assertEquals(FailureKind.UNAVAILABLE, vm.state.value.notice)
        vm.close()
    }

    @Test fun `a failed reload after a refused write keeps the first notice`() = runTest(dispatcher) {
        task()
        val vm = sheet()
        runCurrent()
        fake.onUpdate = { _, _ -> RepositoryResult.Failure(FailureKind.REJECTED) }
        fake.onLoad = { _, _ -> RepositoryResult.Failure(FailureKind.UNAVAILABLE) }

        vm.onAction(ItemDetailsAction.SetPlace("X"))
        runCurrent()

        assertEquals(ItemDetailsPhase.CONTENT, vm.state.value.phase)
        assertEquals(FailureKind.REJECTED, vm.state.value.notice)
        vm.close()
    }

    @Test fun `project people files and links are changed through their own writes`() = runTest(dispatcher) {
        task()
        val vm = sheet()
        runCurrent()

        vm.onAction(ItemDetailsAction.SelectProject("p-home"))
        vm.onAction(ItemDetailsAction.SelectProject(null))
        vm.onAction(ItemDetailsAction.TogglePerson("u1"))
        vm.onAction(ItemDetailsAction.TogglePerson("u2"))
        vm.onAction(ItemDetailsAction.RemoveFile("f1"))
        vm.onAction(ItemDetailsAction.Unlink(LinkedValue.PROJECT))
        vm.onAction(ItemDetailsAction.Relink(LinkedValue.PEOPLE))
        runCurrent()

        assertEquals(
            listOf(
                ItemChange.Project("p-home"),
                ItemChange.Project(null),
                ItemChange.RemovePerson("u1"),
                ItemChange.AddPerson("u2"),
                ItemChange.RemoveFile("f1"),
                ItemChange.Unlink(LinkedValue.PROJECT),
                ItemChange.Relink(LinkedValue.PEOPLE),
            ),
            fake.updates.map { it.second },
        )
        vm.close()
    }

    @Test fun `the choices load once when first asked for and a failure can be retried`() = runTest(dispatcher) {
        task()
        val vm = sheet()
        runCurrent()
        assertEquals(ChoicesPhase.IDLE, vm.state.value.choices)

        fake.projectAnswer = RepositoryResult.Failure(FailureKind.UNAVAILABLE)
        vm.onAction(ItemDetailsAction.LoadChoices)
        assertEquals(ChoicesPhase.LOADING, vm.state.value.choices)
        runCurrent()
        assertEquals(ChoicesPhase.ERROR, vm.state.value.choices)

        fake.projectAnswer = RepositoryResult.Content(listOf(WORK_PROJECT, HOME_PROJECT))
        vm.onAction(ItemDetailsAction.LoadChoices)
        runCurrent()
        assertEquals(ChoicesPhase.READY, vm.state.value.choices)
        assertEquals(listOf("Semprec iOS", "Koupelna"), vm.state.value.projectChoices.map { it.title })
        assertEquals(listOf(karel), vm.state.value.personChoices)

        fake.peopleAnswer = RepositoryResult.Failure(FailureKind.UNAVAILABLE)
        vm.onAction(ItemDetailsAction.LoadChoices)
        runCurrent()
        assertEquals(ChoicesPhase.READY, vm.state.value.choices, "Loaded choices are kept")
        vm.close()
    }

    @Test fun `a failed people list fails the choices`() = runTest(dispatcher) {
        task()
        fake.peopleAnswer = RepositoryResult.Failure(FailureKind.UNAUTHORIZED)
        val vm = sheet()
        runCurrent()

        vm.onAction(ItemDetailsAction.LoadChoices)
        runCurrent()
        assertEquals(ChoicesPhase.ERROR, vm.state.value.choices)
        vm.close()
    }

    @Test fun `deleting moves the item to the trash and closes the sheet`() = runTest(dispatcher) {
        task()
        val vm = sheet()
        runCurrent()
        val received = mutableListOf<ItemDetailsEffect>()
        val collector = launch { vm.effects.collect { received += it } }
        val announced = mutableListOf<Unit>()
        val listener = launch { fake.changes.events.collect { announced += it } }
        runCurrent()

        vm.onAction(ItemDetailsAction.Delete)
        runCurrent()

        assertEquals(listOf("t1"), fake.deleted)
        assertEquals(listOf<ItemDetailsEffect>(ItemDetailsEffect.Deleted), received)
        assertEquals(1, announced.size)
        collector.cancel()
        listener.cancel()
        vm.close()
    }

    @Test fun `a refused delete is a notice and an exception too`() = runTest(dispatcher) {
        task()
        val vm = sheet()
        runCurrent()
        fake.onDelete = { _, _ -> RepositoryResult.Failure(FailureKind.REJECTED) }

        vm.onAction(ItemDetailsAction.Delete)
        runCurrent()
        assertEquals(FailureKind.REJECTED, vm.state.value.notice)

        fake.onDelete = { _, _ -> error("boom") }
        vm.onAction(ItemDetailsAction.DismissNotice)
        vm.onAction(ItemDetailsAction.Delete)
        runCurrent()
        assertEquals(FailureKind.UNAVAILABLE, vm.state.value.notice)
        vm.close()
    }

    @Test fun `actions before the item loaded do nothing`() = runTest(dispatcher) {
        val vm = sheet()

        vm.onAction(ItemDetailsAction.SetTitle("X"))
        vm.onAction(ItemDetailsAction.Delete)
        runCurrent()

        assertTrue(fake.updates.isEmpty())
        assertTrue(fake.deleted.isEmpty())
        vm.close()
    }

    @Test fun `closing ends everything and a late answer publishes nothing`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        fake.onLoad = { _, _ ->
            withContext(NonCancellable) { gate.await() }
            RepositoryResult.Content(invoice)
        }
        val vm = sheet()
        runCurrent()
        vm.close()
        vm.close()
        assertTrue(vm.isClosed)

        gate.complete(Unit)
        runCurrent()
        vm.onAction(ItemDetailsAction.Retry)
        runCurrent()

        assertEquals(ItemDetailsPhase.LOADING, vm.state.value.phase)
        assertEquals(emptyList(), vm.effects.toList())
    }

    @Test fun `clearing the store ends the sheet without close`() = runTest(dispatcher) {
        task()
        val store = ViewModelStore()
        val vm = store.provide { sheet() }
        runCurrent()

        store.clear()

        assertTrue(vm.isClosed)
        vm.onAction(ItemDetailsAction.SetPlace("X"))
        runCurrent()
        assertTrue(fake.updates.isEmpty())
    }
}
