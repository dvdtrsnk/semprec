package cz.semprec.app.presentation

import androidx.lifecycle.ViewModelStore
import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CollectionScope
import cz.semprec.app.domain.FacetResult
import cz.semprec.app.domain.FacetSelection
import cz.semprec.app.domain.FacetValue
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SortSpec
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class, ExperimentalEncodingApi::class)
class CollectionViewModelTest : MainDispatcherTest() {
    private val fake = FakeCollections()
    private val factory = CollectionViewModelFactory(fake, fake)

    private fun TestScope.open(
        key: String? = "projects",
        areaId: String? = null,
        relationKey: String? = null,
        relatedItemId: String? = null,
    ): CollectionViewModel {
        val target = when {
            areaId != null -> CollectionTarget.OfArea(key.orEmpty(), areaId)
            relationKey != null && relatedItemId != null -> CollectionTarget.OfItem(
                key.orEmpty(), relationKey,
                relatedItemId
            )
            else -> CollectionTarget.Whole(key, null)
        }
        val vm = factory.collectionViewModel(target)
        runCurrent()
        return vm
    }

    private val alpha = projectItem("p1", "Alpha", "inProgress", "2027-01-31", area = "Work")
    private val beta = projectItem("p2", "Beta", "done", "2026-10-01")
    private val gamma = projectItem("p3", "Gamma", "inProgress")

    @Test fun `starts loading then shows the rows of the default quick filter`() = runTest(dispatcher) {
        fake.queryAnswer = { _, _ -> page(alpha, beta) }
        val vm = factory.collectionViewModel(CollectionTarget.Whole("projects", null))
        assertEquals(CollectionState(), vm.state.value)
        runCurrent()
        val state = vm.state.value
        assertEquals(CollectionPhase.CONTENT, state.phase)
        assertEquals("Projects", state.header?.name)
        assertEquals("Search projects", state.header?.searchPlaceholder)
        assertEquals(listOf("active", "all"), state.quickFilters.map { it.key })
        assertEquals("active", state.selectedQuickFilter)
        assertEquals(listOf("Alpha", "Beta"), state.sections.single().rows.map { it.title })
        assertEquals(SectionKind.NONE, state.sections.single().kind)
        assertTrue(state.canCreate)
        assertFalse(state.canUpload)
        assertEquals(listOf(CollectionLayout.LIST, CollectionLayout.BOARD), state.layouts)
        assertEquals(1, fake.queries.size)
        assertEquals("""{"type":"in"}""", fake.queries.single().quickFilter?.json)
        assertEquals(listOf("area", "company"), fake.queries.single().expand)
        assertEquals(SortSpec(null, "createdAt", true), fake.queries.single().sort.single())
        vm.close()
    }

    @Test fun `a row carries its status date and the context relation under the title`() = runTest(dispatcher) {
        fake.queryAnswer = { _, _ -> page(alpha) }
        val vm = open()
        val row = vm.state.value.sections.single().rows.single()
        assertEquals("p1", row.id)
        assertEquals(OptionView("inProgress", "In progress", "#007AFF"), row.group)
        assertEquals("2027-01-31", row.date)
        assertEquals(
            listOf<FieldContent>(
                FieldContent.Targets(
                    listOf(
                        TargetView(
                            "area-1", "areas", "Work",
                            "#5856D6"
                        )
                    )
                )
            ),
            row.subtitle
        )
        vm.close()
    }

    @Test fun `no rows is the empty state`() = runTest(dispatcher) {
        val vm = open()
        assertEquals(CollectionPhase.EMPTY, vm.state.value.phase)
        assertTrue(vm.state.value.sections.all { it.rows.isEmpty() })
        vm.close()
    }

    @Test fun `an expected failure is an error with its kind and retry recovers`() = runTest(dispatcher) {
        fake.schemaAnswer = { failure(FailureKind.UNAVAILABLE) }
        val vm = open()
        assertEquals(CollectionState(phase = CollectionPhase.ERROR, failure = FailureKind.UNAVAILABLE), vm.state.value)
        fake.schemaAnswer = { RepositoryResult.Content(testSchema) }
        fake.queryAnswer = { _, _ -> page(alpha) }
        vm.onAction(CollectionAction.Retry)
        assertEquals(CollectionState(), vm.state.value)
        runCurrent()
        assertEquals(CollectionPhase.CONTENT, vm.state.value.phase)
        assertNull(vm.state.value.failure)
        vm.close()
    }

    @Test fun `an unexpected exception is an error without a failure kind`() = runTest(dispatcher) {
        fake.queryAnswer = { _, _ -> throw IllegalStateException("boom") }
        val vm = open()
        assertEquals(CollectionPhase.ERROR, vm.state.value.phase)
        assertNull(vm.state.value.failure)
        assertEquals("Projects", vm.state.value.header?.name)
        vm.close()
    }

    @Test fun `an unknown database is not found`() = runTest(dispatcher) {
        val vm = open(key = "nope")
        assertEquals(FailureKind.NOT_FOUND, vm.state.value.failure)
        assertNull(vm.state.value.header)
        vm.close()
    }

    @Test fun `an area scope on a database without an area filter is invalid`() = runTest(dispatcher) {
        val vm = open(key = "files", areaId = "area-1")
        assertEquals(FailureKind.INVALID_DATA, vm.state.value.failure)
        assertTrue(fake.queries.isEmpty())
        vm.close()
    }

    @Test fun `an area scope reaches the query`() = runTest(dispatcher) {
        val vm = open(areaId = "area-1")
        assertEquals(CollectionScope.Area("area-1"), fake.queries.single().scope)
        vm.close()
    }

    @Test fun `a related scope reaches the query and a new item or file is attached to it`() = runTest(dispatcher) {
        val vm = open(key = "files", relationKey = "projects", relatedItemId = "p1")
        assertEquals(CollectionScope.Related("projects", "p1"), fake.queries.single().scope)
        assertTrue(vm.state.value.canUpload)
        assertFalse(vm.state.value.canCreate)
        vm.onAction(CollectionAction.Write.Upload("a.pdf", "application/pdf", Base64.encode(byteArrayOf(1))))
        runCurrent()
        assertEquals(Triple("a.pdf", "application/pdf", "projects" to "p1"), fake.uploads.single())
        vm.close()
    }

    @Test fun `searching asks the server and keeps the rows on screen meanwhile`() = runTest(dispatcher) {
        fake.queryAnswer = { _, _ -> page(alpha, beta) }
        val vm = open()
        val gate = CompletableDeferred<Unit>()
        fake.queryAnswer = { _, _ ->
            gate.await()
            page(beta)
        }
        vm.onAction(CollectionAction.Search("  be "))
        assertTrue(vm.state.value.refreshing)
        assertEquals(2, vm.state.value.sections.single().rows.size)
        gate.complete(Unit)
        runCurrent()
        assertFalse(vm.state.value.refreshing)
        assertEquals(listOf("Beta"), vm.state.value.sections.single().rows.map { it.title })
        assertEquals("be", vm.state.value.search)
        assertEquals("be", fake.queries.last().search)
        vm.onAction(CollectionAction.Search(""))
        runCurrent()
        assertNull(fake.queries.last().search)
        vm.close()
    }

    @Test fun `a quick filter replaces the filter and takes its own order`() = runTest(dispatcher) {
        val vm = open()
        vm.onAction(CollectionAction.SelectQuickFilter("all"))
        runCurrent()
        val query = fake.queries.last()
        assertNull(query.quickFilter)
        assertEquals(listOf(SortSpec("date", null, false)), query.sort)
        assertEquals("all", vm.state.value.selectedQuickFilter)
        assertEquals(SortAxis.DATE, vm.state.value.selectedSort)
        assertFalse(vm.state.value.descending)
        vm.close()
    }

    @Test fun `choosing an order starts it in its natural direction and again reverses it`() = runTest(dispatcher) {
        val vm = open()
        assertEquals(listOf(SortAxis.TITLE, SortAxis.DATE, SortAxis.GROUP), vm.state.value.sorts.map { it.axis })
        vm.onAction(CollectionAction.SelectSort(SortAxis.TITLE))
        runCurrent()
        assertEquals(listOf(SortSpec("name", null, false)), fake.queries.last().sort)
        assertEquals(SortAxis.TITLE, vm.state.value.selectedSort)
        vm.onAction(CollectionAction.SelectSort(SortAxis.TITLE))
        runCurrent()
        assertEquals(listOf(SortSpec("name", null, true)), fake.queries.last().sort)
        assertTrue(vm.state.value.descending)
        vm.onAction(CollectionAction.SelectSort(SortAxis.DATE))
        runCurrent()
        assertEquals(listOf(SortSpec("date", null, false)), fake.queries.last().sort)
        vm.close()
    }

    @Test fun `sorting by date groups into months and the headings of the server for past and undated items`() =
        runTest(dispatcher) {
            fake.queryAnswer = { _, _ -> page(beta, alpha, gamma) }
            val vm = open()
            vm.onAction(CollectionAction.SelectSort(SortAxis.DATE))
            runCurrent()
            val sections = vm.state.value.sections
            assertEquals(
                listOf(SectionKind.PAST to "Overdue", SectionKind.MONTH to "", SectionKind.NO_VALUE to "No deadline"),
                sections.map { it.kind to it.label },
            )
            assertEquals("2027-01", sections[1].key)
            vm.close()
        }

    @Test fun `sorting by title groups into letters and by status into the options`() = runTest(dispatcher) {
        fake.queryAnswer = { _, _ -> page(alpha, beta, gamma) }
        val vm = open()
        vm.onAction(CollectionAction.SelectSort(SortAxis.TITLE))
        runCurrent()
        assertEquals(listOf("A", "B", "G"), vm.state.value.sections.map { it.key })
        vm.onAction(CollectionAction.SelectSort(SortAxis.GROUP))
        runCurrent()
        val byStatus = vm.state.value.sections
        assertEquals(listOf("inProgress", "done"), byStatus.map { it.key })
        assertEquals(listOf("Alpha", "Gamma"), byStatus.first().rows.map { it.title })
        assertEquals("In progress", byStatus.first().label)
        vm.close()
    }

    @Test fun `the board has a column for every status even without items and a column for items without one`() =
        runTest(dispatcher) {
            fake.queryAnswer = { _, _ -> page(alpha, projectItem("p9", "Nine", status = null)) }
            val vm = open()
            vm.onAction(CollectionAction.SelectLayout(CollectionLayout.BOARD))
            val sections = vm.state.value.sections
            assertEquals(CollectionLayout.BOARD, vm.state.value.layout)
            assertEquals(listOf("inProgress", "longTerm", "done", ""), sections.map { it.key })
            assertEquals(SectionKind.NO_VALUE, sections.last().kind)
            assertEquals(emptyList(), sections[1].rows)
            assertEquals(1, fake.queries.size)
            vm.close()
        }

    @Test fun `a layout the database does not have is ignored`() = runTest(dispatcher) {
        val vm = open()
        vm.onAction(CollectionAction.SelectLayout(CollectionLayout.GALLERY))
        assertEquals(CollectionLayout.LIST, vm.state.value.layout)
        vm.close()
    }

    @Test fun `files have a gallery and a row knows its type`() = runTest(dispatcher) {
        fake.queryAnswer = { _, _ -> page(fileItem("f1", "Faktura.pdf")) }
        val vm = open(key = "files")
        assertEquals(
            listOf(CollectionLayout.LIST, CollectionLayout.GALLERY, CollectionLayout.BOARD),
            vm.state.value.layouts
        )
        vm.onAction(CollectionAction.SelectLayout(CollectionLayout.GALLERY))
        assertEquals(CollectionLayout.GALLERY, vm.state.value.layout)
        assertEquals("PDF", vm.state.value.sections.single().rows.single().fileType)
        vm.close()
    }

    @Test fun `opening the filter sheet loads the choices under the current filter`() = runTest(dispatcher) {
        fake.facetsAnswer = {
            RepositoryResult.Content(
                listOf(
                    FacetResult(
                        "status",
                        listOf(
                            FacetValue("inProgress", "In progress", "#007AFF", 2),
                            FacetValue(
                                "done", null, null,
                                0
                            ),
                            FacetValue(null, null, null, 4)
                        ),
                    ),
                ),
            )
        }
        val vm = open()
        vm.onAction(CollectionAction.Filter.Open)
        assertEquals(FilterSheet(loading = true, failure = null, groups = emptyList()), vm.state.value.filterSheet)
        runCurrent()
        val groups = vm.state.value.filterSheet!!.groups
        assertEquals(listOf("status", "date"), groups.map { it.propertyKey })
        assertEquals(listOf("inProgress"), groups.first().options.map { it.value })
        assertEquals(2, groups.first().options.single().count)
        assertEquals(DATE_PRESETS, groups[1].options.map { it.value })
        assertEquals(listOf("status", "area", "company", "tags"), fake.facetQueries.single().second)
        vm.onAction(CollectionAction.Filter.Close)
        assertNull(vm.state.value.filterSheet)
        vm.close()
    }

    @Test fun `a failed facet read is shown in the sheet`() = runTest(dispatcher) {
        fake.facetsAnswer = { failure(FailureKind.UNAVAILABLE) }
        val vm = open()
        vm.onAction(CollectionAction.Filter.Open)
        runCurrent()
        assertEquals(FilterSheet(false, FailureKind.UNAVAILABLE, emptyList()), vm.state.value.filterSheet)
        vm.close()
    }

    @Test fun `choosing filters queries again with them counts them and refreshes the sheet`() = runTest(dispatcher) {
        fake.facetsAnswer = {
            RepositoryResult.Content(listOf(FacetResult("status", listOf(FacetValue("done", "Done", null, 1)))))
        }
        val vm = open()
        vm.onAction(CollectionAction.Filter.Open)
        runCurrent()
        vm.onAction(CollectionAction.Filter.Toggle("status", "done"))
        vm.onAction(CollectionAction.Filter.ToggleDate("date", "thisWeek"))
        runCurrent()
        assertEquals(
            listOf(FacetSelection.OneOf("status", listOf("done")), FacetSelection.DatePreset("date", "thisWeek")),
            fake.queries.last().selections,
        )
        assertEquals(2, vm.state.value.activeFilterCount)
        assertTrue(vm.state.value.filterSheet!!.groups.first().options.single().selected)
        assertEquals(2, fake.facetQueries.size)
        vm.onAction(CollectionAction.Filter.Toggle("status", "done"))
        vm.onAction(CollectionAction.Filter.ToggleDate("date", "thisWeek"))
        runCurrent()
        assertEquals(0, vm.state.value.activeFilterCount)
        assertEquals(emptyList(), fake.queries.last().selections)
        vm.close()
    }

    @Test fun `clearing one filter or all of them`() = runTest(dispatcher) {
        val vm = open()
        vm.onAction(CollectionAction.Filter.Toggle("status", "done"))
        vm.onAction(CollectionAction.Filter.Toggle("area", "a1"))
        runCurrent()
        vm.onAction(CollectionAction.Filter.Clear("status"))
        runCurrent()
        assertEquals(listOf(FacetSelection.OneOf("area", listOf("a1"))), fake.queries.last().selections)
        vm.onAction(CollectionAction.Filter.ClearAll)
        runCurrent()
        assertEquals(0, vm.state.value.activeFilterCount)
        vm.close()
    }

    @Test fun `the next page is appended once and only while there is one`() = runTest(dispatcher) {
        fake.queryAnswer = { _, query -> if (query.cursor == null) page(alpha, next = "c1") else page(beta) }
        val vm = open()
        assertTrue(vm.state.value.hasMore)
        vm.onAction(CollectionAction.LoadMore)
        assertTrue(vm.state.value.loadingMore)
        vm.onAction(CollectionAction.LoadMore)
        runCurrent()
        assertEquals(listOf("Alpha", "Beta"), vm.state.value.sections.single().rows.map { it.title })
        assertFalse(vm.state.value.hasMore)
        assertFalse(vm.state.value.loadingMore)
        assertEquals(listOf(null, "c1"), fake.queries.map { it.cursor })
        vm.onAction(CollectionAction.LoadMore)
        runCurrent()
        assertEquals(2, fake.queries.size)
        vm.close()
    }

    @Test fun `a failed next page keeps the rows and can be tried again`() = runTest(dispatcher) {
        fake.queryAnswer = { _, query ->
            if (query.cursor == null) page(
                alpha,
                next = "c1"
            ) else failure(FailureKind.UNAVAILABLE)
        }
        val vm = open()
        vm.onAction(CollectionAction.LoadMore)
        runCurrent()
        assertEquals(CollectionPhase.CONTENT, vm.state.value.phase)
        assertFalse(vm.state.value.loadingMore)
        assertTrue(vm.state.value.hasMore)
        fake.queryAnswer = { _, _ -> page(beta) }
        vm.onAction(CollectionAction.LoadMore)
        runCurrent()
        assertEquals(listOf("Alpha", "Beta"), vm.state.value.sections.single().rows.map { it.title })
        vm.close()
    }

    @Test fun `a failed refresh is an error and a refresh without rows to keep reloads`() = runTest(dispatcher) {
        val vm = open()
        fake.queryAnswer = { _, _ -> failure(FailureKind.UNAUTHORIZED) }
        vm.onAction(CollectionAction.Refresh)
        runCurrent()
        assertEquals(FailureKind.UNAUTHORIZED, vm.state.value.failure)
        assertEquals("Projects", vm.state.value.header?.name)
        vm.close()
    }

    @Test fun `a refresh while a newer query runs lets only the newest answer through`() = runTest(dispatcher) {
        val slow = CompletableDeferred<Unit>()
        var calls = 0
        fake.queryAnswer = { _, _ ->
            calls += 1
            if (calls == 2) withContext(NonCancellable) { slow.await() }
            page(if (calls == 2) alpha else beta)
        }
        val vm = open()
        vm.onAction(CollectionAction.Search("a"))
        runCurrent()
        vm.onAction(CollectionAction.Search("b"))
        runCurrent()
        assertEquals(listOf("Beta"), vm.state.value.sections.single().rows.map { it.title })
        slow.complete(Unit)
        runCurrent()
        assertEquals(listOf("Beta"), vm.state.value.sections.single().rows.map { it.title })
        vm.close()
    }

    @Test fun `opening an item emits one effect with the database key`() = runTest(dispatcher) {
        fake.queryAnswer = { _, _ -> page(alpha) }
        val vm = open()
        vm.onAction(CollectionAction.OpenItem("p1"))
        val received = mutableListOf<CollectionEffect>()
        val collector = launch { vm.effects.collect { received += it } }
        runCurrent()
        collector.cancel()
        assertEquals(listOf<CollectionEffect>(CollectionEffect.OpenItem("p1", "projects")), received)
        vm.close()
    }

    @Test fun `creating an item in an area attaches it to the area and opens it`() = runTest(dispatcher) {
        val vm = open(areaId = "area-1")
        vm.onAction(CollectionAction.Write.Create("  New  "))
        assertTrue(vm.state.value.creating)
        vm.onAction(CollectionAction.Write.Create("Second"))
        runCurrent()
        assertEquals(
            listOf(Triple<String, String, Pair<String, String>?>(PROJECTS, "New", "area" to "area-1")),
            fake.creates
        )
        assertFalse(vm.state.value.creating)
        val received = mutableListOf<CollectionEffect>()
        val collector = launch { vm.effects.collect { received += it } }
        runCurrent()
        collector.cancel()
        assertEquals(listOf<CollectionEffect>(CollectionEffect.OpenItem("new", "projects")), received)
        vm.close()
    }

    @Test fun `a blank title creates nothing and a failed creation is a write failure that can be dismissed`() =
        runTest(dispatcher) {
            val vm = open()
            vm.onAction(CollectionAction.Write.Create("   "))
            runCurrent()
            assertTrue(fake.creates.isEmpty())
            fake.createAnswer = { failure(FailureKind.REJECTED) }
            vm.onAction(CollectionAction.Write.Create("X"))
            runCurrent()
            assertEquals(WriteFailure(FailureKind.REJECTED), vm.state.value.writeFailure)
            assertFalse(vm.state.value.creating)
            vm.onAction(CollectionAction.DismissWriteFailure)
            assertNull(vm.state.value.writeFailure)
            fake.createAnswer = { throw IllegalStateException("boom") }
            vm.onAction(CollectionAction.Write.Create("Y"))
            runCurrent()
            assertEquals(WriteFailure(null), vm.state.value.writeFailure)
            vm.close()
        }

    @Test fun `an upload decodes the bytes and reloads the list`() = runTest(dispatcher) {
        val vm = open(key = "files")
        vm.onAction(CollectionAction.Write.Upload("a.pdf", "application/pdf", Base64.encode(byteArrayOf(1, 2))))
        assertTrue(vm.state.value.creating)
        runCurrent()
        assertEquals(Triple("a.pdf", "application/pdf", null), fake.uploads.single())
        assertEquals(2, fake.queries.size)
        assertFalse(vm.state.value.creating)
        vm.close()
    }

    @Test fun `unreadable upload data and a failed upload are write failures`() = runTest(dispatcher) {
        val vm = open(key = "files")
        vm.onAction(CollectionAction.Write.Upload("a.pdf", "application/pdf", "***"))
        assertEquals(WriteFailure(FailureKind.INVALID_DATA), vm.state.value.writeFailure)
        assertTrue(fake.uploads.isEmpty())
        fake.uploadAnswer = { failure(FailureKind.UNAVAILABLE) }
        vm.onAction(CollectionAction.Write.Upload("a.pdf", "application/pdf", Base64.encode(byteArrayOf(1))))
        runCurrent()
        assertEquals(WriteFailure(FailureKind.UNAVAILABLE), vm.state.value.writeFailure)
        assertEquals(1, fake.queries.size)
        vm.close()
    }

    @Test fun `closing ends the work and ignores later actions without an error state`() = runTest(dispatcher) {
        val slow = CompletableDeferred<Unit>()
        fake.queryAnswer = { _, _ ->
            slow.await()
            page(alpha)
        }
        val vm = factory.collectionViewModel(CollectionTarget.Whole("projects", null))
        runCurrent()
        vm.close()
        vm.close()
        slow.complete(Unit)
        runCurrent()
        assertEquals(CollectionState(), vm.state.value)
        vm.onAction(CollectionAction.Retry)
        vm.onAction(CollectionAction.Search("x"))
        vm.onAction(CollectionAction.OpenItem("p1"))
        runCurrent()
        assertEquals(CollectionState(), vm.state.value)
        assertEquals(1, fake.queries.size)
        assertEquals(emptyList(), vm.effects.toList())
    }

    @Test fun `clearing the owning store ends it like close`() = runTest(dispatcher) {
        val store = ViewModelStore()
        val vm = store.provide { factory.collectionViewModel(CollectionTarget.Whole("projects", null)) }
        runCurrent()
        store.clear()
        assertTrue(vm.isClosed)
        vm.onAction(CollectionAction.Search("x"))
        runCurrent()
        assertEquals(1, fake.queries.size)
    }
}
