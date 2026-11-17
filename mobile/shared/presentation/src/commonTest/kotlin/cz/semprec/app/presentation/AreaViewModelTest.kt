package cz.semprec.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.ItemKind
import cz.semprec.app.domain.CollectionDatabase
import cz.semprec.app.domain.CollectionItem
import cz.semprec.app.domain.CollectionPage
import cz.semprec.app.domain.CollectionProperty
import cz.semprec.app.domain.CollectionSchema
import cz.semprec.app.domain.CollectionScope
import cz.semprec.app.domain.FacetSelection
import cz.semprec.app.domain.FieldValue
import cz.semprec.app.domain.FilterTree
import cz.semprec.app.domain.NewTask
import cz.semprec.app.domain.PropertyKind
import cz.semprec.app.domain.RelatedCollection
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SortSpec
import cz.semprec.app.domain.TaskRepository
import cz.semprec.app.domain.TaskScope
import cz.semprec.app.domain.WorkItem
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val AREA = "a-work"
private const val AREA_TODAY = "2026-10-21"
private const val EVENTS = "db-events"
private const val MAIL = "db-threads"

private val DATE_PROPERTY = CollectionProperty("pd", "date", "Date", PropertyKind.DATE, emptyList(), null, false, true)
private val EVENT_TITLE = CollectionProperty("pn", "name", "Name", PropertyKind.TITLE, emptyList(), null, false, false)

private val eventsDb = CollectionDatabase(
    id = EVENTS,
    key = "events",
    name = "Events",
    icon = "calendar",
    color = "#FF3B30",
    searchPlaceholder = null,
    properties = listOf(EVENT_TITLE, DATE_PROPERTY),
    quickFilters = emptyList(),
    defaultSort = SortSpec("date", null, descending = false),
    dateLabels = null,
    collectionFilter = null,
    areaFilter = FilterTree("""{"type":"relation_contains","property":"area"}"""),
    pickerFilter = null,
)

private val threadsDb = eventsDb.copy(id = MAIL, key = "threads", name = "Mail", icon = "mail", color = "#1C6ED6")

private val schemaWithEvents = CollectionSchema("2026-10-21", testSchema.databases + eventsDb + threadsDb)

private fun areaItem(vararg extra: Pair<String, FieldValue>, version: String = "v1") = CollectionItem(
    id = AREA,
    databaseId = AREAS,
    values = mapOf("name" to FieldValue.Text("Work")) + extra,
    origins = emptyMap(),
    createdAt = "2026-01-01T00:00:00Z",
    version = version,
)

private fun eventItem(id: String, title: String, at: String) = CollectionItem(
    id = id,
    databaseId = EVENTS,
    values = mapOf("name" to FieldValue.Text(title), "date" to FieldValue.Text(at)),
    origins = emptyMap(),
    createdAt = "2026-01-01T00:00:00Z",
    version = "e1",
)

private val workProject = WORK_PROJECT
private val otherProject = HOME_PROJECT

private class ScriptedAreaTasks(var answer: suspend () -> RepositoryResult<List<WorkItem>>) : TaskRepository {
    var calls = 0
        private set
    var cancellations = 0
        private set

    override suspend fun tasks(scope: TaskScope): RepositoryResult<List<WorkItem>> {
        calls += 1
        return try {
            answer()
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            cancellations += 1
            throw cancelled
        }
    }

    override suspend fun create(task: NewTask): RepositoryResult<WorkItem> = error("not used")
}

@OptIn(ExperimentalCoroutinesApi::class)
class AreaViewModelTest : MainDispatcherTest() {
    private val collections = FakeCollections().also {
        it.schemaAnswer = { RepositoryResult.Content(schemaWithEvents) }
        it.itemAnswer = { RepositoryResult.Content(areaItem(version = "v1")) }
        it.relatedAnswer = {
            RepositoryResult.Content(
                listOf(
                    RelatedCollection("projects", PROJECTS, 3, FilterTree("""{"p":1}""")),
                    RelatedCollection("tasks", "db-tasks-unknown", 5, null),
                    RelatedCollection("threads", MAIL, 2, null),
                    RelatedCollection("files", FILES, 0, null),
                    RelatedCollection("files", FILES, 4, null),
                ),
            )
        }
        it.queryAnswer = { _, _ ->
            RepositoryResult.Content(
                CollectionPage(
                    listOf(
                        eventItem("e1", "Call", "2026-10-22T14:00:00Z"),
                        eventItem("e2", "Standup", "2026-10-21"),
                    ),
                    null,
                ),
            )
        }
    }

    private val tasks = ScriptedAreaTasks {
        RepositoryResult.Content(
            listOf(
                aTask("late", date = "2026-10-19", project = workProject),
                aTask("today", date = AREA_TODAY, from = "09:00", project = workProject),
                aTask("later", date = "2026-10-30", project = workProject),
                aTask("undated", date = null, effective = null, project = workProject),
                aTask("done", date = AREA_TODAY, status = cz.semprec.app.core.TaskStatus.DONE, project = workProject),
                aTask("elsewhere", date = AREA_TODAY, project = otherProject),
                aTask("projectless", date = AREA_TODAY, project = null),
            ),
        )
    }

    private fun viewModel(today: () -> String = { AREA_TODAY }) = AreaViewModelFactory(collections, collections, tasks)
        .areaViewModel(AREA, today)

    private suspend fun TestScope.effectsOf(vm: AreaViewModel): List<AreaEffect> {
        val received = mutableListOf<AreaEffect>()
        val collector = launch { vm.effects.collect { received += it } }
        runCurrent()
        collector.cancel()
        return received
    }

    @Test fun `loads the area the connections and what is coming up`() = runTest(dispatcher) {
        val vm = viewModel()
        assertEquals(AreaState(), vm.state.value)
        runCurrent()
        val state = vm.state.value
        assertEquals(AreaPhase.CONTENT, state.phase)
        assertEquals("Work", state.name)
        assertEquals(true, state.active)
        assertNull(state.color)
        assertEquals(2, state.tasksToday)
        assertEquals(4, state.tasksOpen)
        assertEquals(2, state.eventsSoon)
        assertEquals(
            listOf("late", "e2", "today", "e1", "later", "undated"),
            state.upcoming.map { it.id },
        )
        assertEquals(
            listOf(ItemKind.TASK, ItemKind.EVENT, ItemKind.TASK, ItemKind.EVENT, ItemKind.TASK, ItemKind.TASK),
            state.upcoming.map { it.kind },
        )
        assertEquals("Semprec iOS", state.upcoming.first().projectTitle)
        assertEquals("09:00", state.upcoming[2].timeFrom)
        assertEquals("14:00", state.upcoming.first { it.id == "e1" }.timeFrom)
        assertEquals("2026-10-22", state.upcoming.first { it.id == "e1" }.date)
        assertNull(state.upcoming.first { it.id == "e2" }.timeFrom)
        vm.close()
    }

    @Test fun `connections come from the schema in the order of the server without empty or unknown ones`() =
        runTest(dispatcher) {
            val vm = viewModel()
            runCurrent()
            assertEquals(
                listOf(
                    AreaRelatedItem(PROJECTS, "projects", "Projects", "folder", "#AF52DE", 3, """{"p":1}"""),
                    AreaRelatedItem(MAIL, "threads", "Mail", "mail", "#1C6ED6", 2, null),
                    AreaRelatedItem(FILES, "files", "Files", "doc", "#636366", 4, null),
                ),
                vm.state.value.related,
            )
            vm.close()
        }

    @Test fun `the color the icon and an inactive flag of the area are shown`() = runTest(dispatcher) {
        collections.itemAnswer = {
            RepositoryResult.Content(
                areaItem(
                    "color" to FieldValue.Text("#5856D6"),
                    "icon" to FieldValue.Text("briefcase"),
                    "active" to FieldValue.Flag(false),
                ),
            )
        }
        val vm = viewModel()
        runCurrent()
        assertEquals("#5856D6", vm.state.value.color)
        assertEquals("briefcase", vm.state.value.icon)
        assertEquals(false, vm.state.value.active)
        vm.close()
    }

    @Test fun `the events are asked for in the area from today on ordered by date`() = runTest(dispatcher) {
        val vm = viewModel()
        runCurrent()
        val query = collections.queries.single()
        assertEquals(CollectionScope.Area(AREA), query.scope)
        assertEquals(listOf<FacetSelection>(FacetSelection.DatePreset("date", "upcoming")), query.selections)
        assertEquals(listOf(SortSpec("date", null, descending = false)), query.sort)
        vm.close()
    }

    @Test fun `without an events database or a date property there are no events and nothing is asked`() =
        runTest(dispatcher) {
            collections.schemaAnswer = { RepositoryResult.Content(testSchema) }
            val first = viewModel()
            runCurrent()
            assertEquals(0, first.state.value.eventsSoon)
            first.close()
            val noDate = eventsDb.copy(properties = listOf(EVENT_TITLE))
            val withoutDate = CollectionSchema(AREA_TODAY, testSchema.databases + noDate)
            collections.schemaAnswer = { RepositoryResult.Content(withoutDate) }
            val second = viewModel()
            runCurrent()
            assertEquals(0, second.state.value.eventsSoon)
            assertTrue(collections.queries.isEmpty())
            second.close()
        }

    @Test fun `a date that is only a system property is used when no other exists`() = runTest(dispatcher) {
        val system = eventsDb.copy(properties = listOf(EVENT_TITLE, DATE_PROPERTY.copy(system = true)))
        collections.schemaAnswer = {
            RepositoryResult.Content(CollectionSchema(AREA_TODAY, testSchema.databases + system))
        }
        val vm = viewModel()
        runCurrent()
        val selection = collections.queries.single().selections.single()
        assertEquals(FacetSelection.DatePreset("date", "upcoming"), selection)
        vm.close()
    }

    @Test fun `every failure of a read is an error with its kind`() = runTest(dispatcher) {
        val unavailable = RepositoryResult.Failure(FailureKind.UNAVAILABLE)
        val breaks = listOf<() -> Unit>(
            { collections.schemaAnswer = { unavailable } },
            { collections.itemAnswer = { RepositoryResult.Failure(FailureKind.NOT_FOUND) } },
            { collections.relatedAnswer = { unavailable } },
            { tasks.answer = { unavailable } },
            { collections.queryAnswer = { _, _ -> unavailable } },
        )
        val kinds = listOf(
            FailureKind.UNAVAILABLE,
            FailureKind.NOT_FOUND,
            FailureKind.UNAVAILABLE,
            FailureKind.UNAVAILABLE,
            FailureKind.UNAVAILABLE,
        )
        breaks.zip(kinds).forEach { (breakIt, kind) ->
            breakIt()
            val vm = viewModel()
            runCurrent()
            assertEquals(AreaState(AreaPhase.ERROR, kind), vm.state.value)
            vm.close()
            collections.schemaAnswer = { RepositoryResult.Content(schemaWithEvents) }
            collections.itemAnswer = { RepositoryResult.Content(areaItem()) }
            collections.relatedAnswer = { RepositoryResult.Content(emptyList()) }
            tasks.answer = { RepositoryResult.Content(emptyList()) }
            collections.queryAnswer = { _, _ -> RepositoryResult.Content(CollectionPage(emptyList(), null)) }
        }
    }

    @Test fun `a server without an areas database is not found`() = runTest(dispatcher) {
        collections.schemaAnswer = { RepositoryResult.Content(CollectionSchema(AREA_TODAY, listOf(projectsDb))) }
        val vm = viewModel()
        runCurrent()
        assertEquals(AreaState(AreaPhase.ERROR, FailureKind.NOT_FOUND), vm.state.value)
        vm.close()
    }

    @Test fun `an unexpected exception is an error without a kind and retry loads again`() = runTest(dispatcher) {
        var crash = true
        tasks.answer = { if (crash) error("unexpected") else RepositoryResult.Content(emptyList()) }
        val vm = viewModel()
        runCurrent()
        assertEquals(AreaState(AreaPhase.ERROR, null), vm.state.value)
        crash = false
        vm.onAction(AreaAction.Retry)
        assertEquals(AreaState(), vm.state.value)
        runCurrent()
        assertEquals(AreaPhase.CONTENT, vm.state.value.phase)
        vm.close()
    }

    @Test fun `a refresh keeps the content while it reloads and a failed refresh leaves it as it was`() =
        runTest(dispatcher) {
            val vm = viewModel()
            runCurrent()
            val loaded = vm.state.value
            val gate = CompletableDeferred<Unit>()
            tasks.answer = {
                gate.await()
                RepositoryResult.Failure(FailureKind.UNAVAILABLE)
            }
            vm.onAction(AreaAction.Refresh)
            assertEquals(loaded, vm.state.value)
            gate.complete(Unit)
            runCurrent()
            assertEquals(loaded, vm.state.value)
            vm.close()
        }

    @Test fun `a refresh without content is a retry`() = runTest(dispatcher) {
        tasks.answer = { RepositoryResult.Failure(FailureKind.UNAVAILABLE) }
        val vm = viewModel()
        runCurrent()
        tasks.answer = { RepositoryResult.Content(emptyList()) }
        vm.onAction(AreaAction.Refresh)
        assertEquals(AreaPhase.LOADING, vm.state.value.phase)
        runCurrent()
        assertEquals(AreaPhase.CONTENT, vm.state.value.phase)
        vm.close()
    }

    @Test fun `a newer read cancels the one before and a late answer is not published`() = runTest(dispatcher) {
        val gate = CompletableDeferred<Unit>()
        var first = true
        tasks.answer = {
            if (first) {
                first = false
                kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) { gate.await() }
                RepositoryResult.Content(listOf(aTask("stale", project = workProject)))
            } else {
                RepositoryResult.Content(emptyList())
            }
        }
        val vm = viewModel()
        runCurrent()
        vm.onAction(AreaAction.Retry)
        runCurrent()
        gate.complete(Unit)
        runCurrent()
        assertEquals(0, vm.state.value.tasksOpen)
        vm.close()
    }

    @Test fun `the day is asked for whenever the area is read`() = runTest(dispatcher) {
        var day = AREA_TODAY
        val vm = viewModel { day }
        runCurrent()
        assertEquals(2, vm.state.value.tasksToday)
        day = "2026-10-01"
        vm.onAction(AreaAction.Retry)
        runCurrent()
        assertEquals(0, vm.state.value.tasksToday)
        vm.close()
    }

    @Test fun `opening the tasks the notes a task an event and an unknown id`() = runTest(dispatcher) {
        val vm = viewModel()
        runCurrent()
        vm.onAction(AreaAction.OpenTasks(todayOnly = true))
        vm.onAction(AreaAction.OpenTasks(todayOnly = false))
        vm.onAction(AreaAction.OpenNotes)
        vm.onAction(AreaAction.OpenUpcoming("today"))
        vm.onAction(AreaAction.OpenUpcoming("e1"))
        vm.onAction(AreaAction.OpenUpcoming("nope"))
        assertEquals(
            listOf(
                AreaEffect.OpenTasks(true),
                AreaEffect.OpenTasks(false),
                AreaEffect.OpenNotes,
                AreaEffect.OpenDetails(ItemKind.TASK, "today"),
                AreaEffect.OpenDetails(ItemKind.EVENT, "e1"),
            ),
            effectsOf(vm),
        )
        assertTrue(effectsOf(vm).isEmpty(), "A delivered effect is not delivered again")
        vm.close()
    }

    @Test fun `a connection opens the collection its filter selects the whole one the mail or the tasks`() =
        runTest(dispatcher) {
            collections.relatedAnswer = {
                RepositoryResult.Content(
                    listOf(
                        RelatedCollection("projects", PROJECTS, 3, FilterTree("""{"p":1}""")),
                        RelatedCollection("threads", MAIL, 2, null),
                        RelatedCollection("files", FILES, 4, null),
                        RelatedCollection("tasks", AREAS, 1, null),
                    ),
                )
            }
            val vm = viewModel()
            runCurrent()
            listOf(PROJECTS, MAIL, FILES, "nope").forEach { vm.onAction(AreaAction.OpenRelated(it)) }
            assertEquals(
                listOf<AreaEffect>(
                    AreaEffect.OpenCollection(CollectionTarget.Matching("projects", PROJECTS, """{"p":1}""")),
                    AreaEffect.OpenMail,
                    AreaEffect.OpenCollection(CollectionTarget.Whole("files", FILES)),
                ),
                effectsOf(vm),
            )
            vm.close()
        }

    @Test fun `the tasks connection opens every open task of the area`() = runTest(dispatcher) {
        collections.relatedAnswer = {
            RepositoryResult.Content(listOf(RelatedCollection("tasks", PROJECTS, 1, FilterTree("{}"))))
        }
        val vm = viewModel()
        runCurrent()
        vm.onAction(AreaAction.OpenRelated(PROJECTS))
        assertEquals(listOf<AreaEffect>(AreaEffect.OpenTasks(todayOnly = false)), effectsOf(vm))
        vm.close()
    }

    @Test fun `making the area inactive writes the flag with the version and the next write uses the new one`() =
        runTest(dispatcher) {
            collections.updateAnswer = { RepositoryResult.Content(areaItem(version = "v2")) }
            val vm = viewModel()
            runCurrent()
            vm.onAction(AreaAction.SetActive(false))
            assertTrue(vm.state.value.activeSaving)
            runCurrent()
            val flag = mapOf<String, FieldValue?>("active" to FieldValue.Flag(false))
            assertEquals(Triple(AREA, "v1", flag), collections.updates.single())
            assertEquals(false, vm.state.value.active)
            assertEquals(false, vm.state.value.activeSaving)
            collections.updateAnswer = { RepositoryResult.Content(areaItem(version = "v3")) }
            vm.onAction(AreaAction.SetActive(true))
            runCurrent()
            assertEquals("v2", collections.updates.last().second)
            assertEquals(true, vm.state.value.active)
            vm.close()
        }

    @Test fun `a refused write keeps the switch where it was and says why until dismissed`() = runTest(dispatcher) {
        collections.updateAnswer = { RepositoryResult.Failure(FailureKind.REJECTED) }
        val vm = viewModel()
        runCurrent()
        vm.onAction(AreaAction.SetActive(false))
        runCurrent()
        assertEquals(true, vm.state.value.active)
        assertEquals(false, vm.state.value.activeSaving)
        assertEquals(Failed(FailureKind.REJECTED), vm.state.value.writeFailure)
        vm.onAction(AreaAction.DismissFailure)
        assertNull(vm.state.value.writeFailure)
        vm.close()
    }

    @Test fun `a write without a schema areas database fails as not found`() = runTest(dispatcher) {
        val vm = viewModel()
        runCurrent()
        collections.schemaAnswer = { RepositoryResult.Content(CollectionSchema(AREA_TODAY, listOf(projectsDb))) }
        vm.onAction(AreaAction.SetActive(false))
        runCurrent()
        assertEquals(Failed(FailureKind.NOT_FOUND), vm.state.value.writeFailure)
        assertTrue(collections.updates.isEmpty())
        vm.close()
    }

    @Test fun `a switch to what it already is while saving or before the content sends nothing`() =
        runTest(dispatcher) {
            val vm = viewModel()
            vm.onAction(AreaAction.SetActive(false))
            runCurrent()
            vm.onAction(AreaAction.SetActive(true))
            val gate = CompletableDeferred<Unit>()
            collections.updateAnswer = {
                gate.await()
                RepositoryResult.Content(areaItem(version = "v2"))
            }
            vm.onAction(AreaAction.SetActive(false))
            vm.onAction(AreaAction.SetActive(false))
            runCurrent()
            assertEquals(1, collections.updates.size)
            gate.complete(Unit)
            runCurrent()
            vm.close()
        }

    @Test fun `closing cancels the read and ignores later actions and clearing the store does the same`() =
        runTest(dispatcher) {
            tasks.answer = { kotlinx.coroutines.awaitCancellation() }
            val vm = viewModel()
            runCurrent()
            vm.close()
            runCurrent()
            assertEquals(1, tasks.cancellations)
            vm.onAction(AreaAction.Retry)
            vm.onAction(AreaAction.OpenNotes)
            runCurrent()
            assertEquals(1, tasks.calls)
            assertTrue(vm.effects.toList().isEmpty())

            val store = ViewModelStore()
            val owned = store.provide {
                AreaViewModelFactory(collections, collections, tasks).areaViewModel(AREA) { AREA_TODAY }
            }
            runCurrent()
            store.clear()
            runCurrent()
            assertTrue(owned.isClosed)
            assertEquals(2, tasks.cancellations)
        }

    @Test fun `a write elsewhere in the window reads the area again`() = runTest(dispatcher) {
        val changes = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
        val vm = AreaViewModelFactory(collections, collections, tasks, changes).areaViewModel(AREA) { AREA_TODAY }
        runCurrent()
        assertEquals(2, vm.state.value.tasksToday)
        val reads = tasks.calls
        tasks.answer = {
            RepositoryResult.Content(listOf(aTask("new", date = AREA_TODAY, from = "08:00", project = workProject)))
        }
        changes.emit(Unit)
        runCurrent()
        assertEquals(reads + 1, tasks.calls)
        assertEquals(1, vm.state.value.tasksToday)
        vm.close()
    }
}
