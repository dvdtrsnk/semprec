package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.CollectionDatabase
import cz.semprec.app.domain.CollectionSchema
import cz.semprec.app.domain.FacetResult
import cz.semprec.app.domain.FacetSelection
import cz.semprec.app.domain.FacetValue
import cz.semprec.app.domain.FieldValue
import cz.semprec.app.domain.FilterTree
import cz.semprec.app.domain.RepositoryResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The chip bar of a database that declares a facet bar property, and how it shares the filter sheet's selection. */
@OptIn(ExperimentalCoroutinesApi::class)
class CollectionFacetBarTest : MainDispatcherTest() {
    private val fake = FakeCollections()
    private val factory = CollectionViewModelFactory(fake, fake)
    private val taggedProjects = projectsDb.copy(facetBarProperty = "tags")

    private val tagFacet = FacetResult(
        "tags",
        listOf(
            FacetValue("a", "Client", "#FF9500", 3),
            FacetValue("b", null, null, 1),
            FacetValue("c", "Unused", null, 0),
            FacetValue(null, null, null, 5),
        ),
    )

    /** Answers the bar's own facet read with [bar] and the sheet's read of every filterable property with [sheet]. */
    private fun answerFacets(
        bar: RepositoryResult<List<FacetResult>> = RepositoryResult.Content(listOf(tagFacet)),
        sheet: List<FacetResult> = listOf(tagFacet),
    ) {
        fake.facetsAnswer = {
            if (fake.facetQueries.last().second == listOf("tags")) bar else RepositoryResult.Content(sheet)
        }
    }

    private fun TestScope.open(schema: CollectionSchema = testSchema.with(taggedProjects)): CollectionViewModel {
        fake.schemaAnswer = { RepositoryResult.Content(schema) }
        fake.queryAnswer = { _, _ -> page(projectItem("p1", "Alpha")) }
        val vm = factory.collectionViewModel(CollectionTarget.Whole("projects", null))
        runCurrent()
        return vm
    }

    private val barReads get() = fake.facetQueries.filter { it.second == listOf("tags") }

    @Test fun `a declared bar has one chip per held tag with its count read with the screen`() = runTest(dispatcher) {
        answerFacets()
        val vm = open()
        assertEquals(
            FacetBar(
                "tags",
                listOf(
                    FilterOption("a", "Client", "#FF9500", 3, selected = false),
                    FilterOption("b", "B", null, 1, selected = false),
                ),
            ),
            vm.state.value.facetBar,
        )
        val read = barReads.single().first
        assertEquals(FilterTree("""{"type":"in"}"""), read.quickFilter)
        assertEquals(emptyList(), read.selections)
        vm.close()
    }

    @Test fun `a database without the declaration has no bar and reads no facet`() = runTest(dispatcher) {
        answerFacets()
        val vm = open(testSchema)
        assertNull(vm.state.value.facetBar)
        assertTrue(fake.facetQueries.isEmpty())
        vm.close()
    }

    @Test fun `the bar is hidden while no project holds a tag`() = runTest(dispatcher) {
        val untagged = FacetResult("tags", listOf(FacetValue(null, null, null, 4)))
        answerFacets(bar = RepositoryResult.Content(listOf(untagged)))
        val vm = open()
        assertEquals(1, barReads.size)
        assertNull(vm.state.value.facetBar)
        vm.close()
    }

    @Test fun `two chips query with an in condition beside the quick filter and the sheet shows them selected`() =
        runTest(dispatcher) {
            answerFacets()
            val vm = open()
            vm.onAction(CollectionAction.Filter.Toggle("tags", "a"))
            vm.onAction(CollectionAction.Filter.Toggle("tags", "b"))
            runCurrent()
            val query = fake.queries.last()
            assertEquals(listOf(FacetSelection.OneOf("tags", listOf("a", "b"))), query.selections)
            assertEquals(FilterTree("""{"type":"in"}"""), query.quickFilter)
            assertEquals(listOf(true, true), vm.state.value.facetBar?.chips?.map { it.selected })
            assertEquals(2, barReads.size)
            assertEquals(listOf(FacetSelection.OneOf("tags", listOf("a", "b"))), barReads.last().first.selections)

            vm.onAction(CollectionAction.Filter.Open)
            runCurrent()
            val tags = assertNotNull(vm.state.value.filterSheet).groups.single { it.propertyKey == "tags" }
            assertEquals(listOf("a", "b"), tags.options.filter { it.selected }.map { it.value })
            vm.close()
        }

    @Test fun `clearing in the sheet unselects the chips`() = runTest(dispatcher) {
        answerFacets()
        val vm = open()
        vm.onAction(CollectionAction.Filter.Toggle("tags", "a"))
        runCurrent()
        vm.onAction(CollectionAction.Filter.Open)
        runCurrent()
        vm.onAction(CollectionAction.Filter.Clear("tags"))
        runCurrent()
        assertEquals(listOf(false, false), vm.state.value.facetBar?.chips?.map { it.selected })
        assertEquals(emptyList(), fake.queries.last().selections)
        vm.onAction(CollectionAction.Filter.Toggle("tags", "b"))
        runCurrent()
        vm.onAction(CollectionAction.Filter.ClearAll)
        runCurrent()
        assertEquals(listOf(false, false), vm.state.value.facetBar?.chips?.map { it.selected })
        vm.close()
    }

    @Test fun `a bar that cannot be read again keeps its chips`() = runTest(dispatcher) {
        answerFacets()
        val vm = open()
        answerFacets(bar = failure(FailureKind.UNAVAILABLE))
        vm.onAction(CollectionAction.Filter.Toggle("tags", "a"))
        runCurrent()
        assertEquals(listOf("a", "b"), vm.state.value.facetBar?.chips?.map { it.value })
        assertEquals(listOf(true, false), vm.state.value.facetBar?.chips?.map { it.selected })
        vm.close()
    }

    @Test fun `a failed first query reads no bar`() = runTest(dispatcher) {
        answerFacets()
        fake.schemaAnswer = { RepositoryResult.Content(testSchema.with(taggedProjects)) }
        fake.queryAnswer = { _, _ -> failure(FailureKind.UNAVAILABLE) }
        val vm = factory.collectionViewModel(CollectionTarget.Whole("projects", null))
        runCurrent()
        assertEquals(CollectionPhase.ERROR, vm.state.value.phase)
        assertTrue(barReads.isEmpty())
        vm.close()
    }

    @Test fun `the sheet offers the bar property even when the schema knew none of its tags`() = runTest(dispatcher) {
        val untagged = taggedProjects.copy(
            properties = taggedProjects.properties.map { if (it.key == "tags") it.copy(options = emptyList()) else it },
        )
        answerFacets()
        val vm = open(testSchema.with(untagged))
        vm.onAction(CollectionAction.Filter.Open)
        runCurrent()
        val sheetKeys = fake.facetQueries.last().second
        assertTrue("tags" in sheetKeys)
        val tags = assertNotNull(vm.state.value.filterSheet).groups.single { it.propertyKey == "tags" }
        assertEquals(listOf("Client", "b"), tags.options.map { it.label })
        assertEquals(listOf("Client", "b"), vm.state.value.facetBar?.chips?.map { it.label })
        vm.close()
    }

    @Test fun `the row subtitle includes the project's tags`() = runTest(dispatcher) {
        answerFacets()
        fake.schemaAnswer = { RepositoryResult.Content(testSchema.with(taggedProjects)) }
        fake.queryAnswer = { _, _ ->
            page(projectItem("p1", "Alpha", extra = mapOf("tags" to FieldValue.Choices(listOf("a", "b")))))
        }
        val vm = factory.collectionViewModel(CollectionTarget.Whole("projects", null))
        runCurrent()
        val row = vm.state.value.sections.flatMap { it.rows }.single()
        assertEquals(
            listOf<FieldContent>(FieldContent.Choices(listOf(OptionView("a", "A", null), OptionView("b", "B", null)))),
            row.subtitle,
        )
        vm.close()
    }

    @Test fun `a later query reads the bar again and an older bar answer is dropped`() = runTest(dispatcher) {
        val slow = CompletableDeferred<RepositoryResult<List<FacetResult>>>()
        fake.facetsAnswer = { slow.await() }
        val vm = open()
        fake.facetsAnswer = {
            RepositoryResult.Content(listOf(FacetResult("tags", listOf(FacetValue("b", "Bee", null, 2)))))
        }
        vm.onAction(CollectionAction.Search("x"))
        runCurrent()
        slow.complete(RepositoryResult.Content(listOf(tagFacet)))
        runCurrent()
        assertEquals(listOf("Bee"), vm.state.value.facetBar?.chips?.map { it.label })
        assertEquals("x", barReads.last().first.search)
        vm.close()
    }
}

private fun CollectionSchema.with(database: CollectionDatabase) =
    copy(databases = databases.map { if (it.id == database.id) database else it })
