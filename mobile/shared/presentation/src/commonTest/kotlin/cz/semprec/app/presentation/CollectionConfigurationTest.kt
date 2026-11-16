package cz.semprec.app.presentation

import cz.semprec.app.domain.CollectionDatabase
import cz.semprec.app.domain.CollectionItem
import cz.semprec.app.domain.CollectionPage
import cz.semprec.app.domain.CollectionProperty
import cz.semprec.app.domain.CollectionSchema
import cz.semprec.app.domain.FieldValue
import cz.semprec.app.domain.PropertyKind
import cz.semprec.app.domain.PropertyOption
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SortSpec
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

private const val BOOKS = "db-books"

private fun bookProperty(key: String, kind: PropertyKind, options: List<PropertyOption> = emptyList()) =
    CollectionProperty("p-$key", key, key, kind, options, null, system = false, filterable = true)

private fun booksDatabase(key: String, vararg extra: CollectionProperty) = CollectionDatabase(
    id = BOOKS,
    key = key,
    name = "Books",
    icon = "book",
    color = "#A2845E",
    searchPlaceholder = null,
    properties = listOf(
        bookProperty("name", PropertyKind.TITLE),
        bookProperty(
            "status",
            PropertyKind.SELECT,
            listOf(PropertyOption("toRead", "To read", null), PropertyOption("read", "Read", "#34C759")),
        ),
        bookProperty("cover", PropertyKind.IMAGE),
    ) + extra,
    quickFilters = emptyList(),
    defaultSort = SortSpec("name", null, descending = false),
    dateLabels = null,
    collectionFilter = null,
    areaFilter = null,
    pickerFilter = null,
)

private fun book(id: String, rating: FieldValue?) = CollectionItem(
    id = id,
    databaseId = BOOKS,
    values = mapOf("name" to FieldValue.Text("Book $id")) + listOfNotNull(rating?.let { "rating" to it }),
    origins = emptyMap(),
    createdAt = "2026-01-01T00:00:00Z",
    version = "v1",
)

@OptIn(ExperimentalCoroutinesApi::class)
class CollectionConfigurationTest : MainDispatcherTest() {
    private fun viewModel(database: CollectionDatabase, vararg items: CollectionItem): CollectionViewModel {
        val collections = FakeCollections()
        collections.schemaAnswer = { RepositoryResult.Content(CollectionSchema("2026-10-16", listOf(database))) }
        collections.queryAnswer = { _, _ -> RepositoryResult.Content(CollectionPage(items.toList(), null)) }
        return CollectionViewModelFactory(collections, collections)
            .collectionViewModel(CollectionTarget.Whole(null, BOOKS))
    }

    private val rating = bookProperty("rating", PropertyKind.NUMBER)

    @Test fun `a collection of books opens as tiles and the person can still choose rows`() = runTest(dispatcher) {
        val vm = viewModel(booksDatabase("books", rating), book("a", FieldValue.Number(4.0)))
        runCurrent()
        assertEquals(CollectionLayout.GALLERY, vm.state.value.layout)
        assertEquals(
            listOf(CollectionLayout.LIST, CollectionLayout.GALLERY, CollectionLayout.BOARD),
            vm.state.value.layouts,
        )
        vm.onAction(CollectionAction.SelectLayout(CollectionLayout.LIST))
        runCurrent()
        assertEquals(CollectionLayout.LIST, vm.state.value.layout)
        vm.close()
    }

    @Test fun `movies and recipes open as tiles too and any other collection with a cover opens as rows`() =
        runTest(dispatcher) {
            val expected = mapOf(
                "movies" to CollectionLayout.GALLERY,
                "recipes" to CollectionLayout.GALLERY,
                "files" to CollectionLayout.LIST,
            )
            expected.forEach { (key, layout) ->
                val vm = viewModel(booksDatabase(key))
                runCurrent()
                assertEquals(layout, vm.state.value.layout, key)
                vm.close()
            }
        }

    @Test fun `a media collection without a cover or photo opens as rows`() = runTest(dispatcher) {
        val books = booksDatabase("books")
        val withoutCover = books.copy(properties = books.properties.filter { it.key != "cover" })
        val vm = viewModel(withoutCover)
        runCurrent()
        assertEquals(CollectionLayout.LIST, vm.state.value.layout)
        vm.close()
    }

    @Test fun `the stars of an item are its rating from one to five and nothing else`() = runTest(dispatcher) {
        val vm = viewModel(
            booksDatabase("books", rating),
            book("four", FieldValue.Number(4.0)),
            book("zero", FieldValue.Number(0.0)),
            book("none", null),
            book("six", FieldValue.Number(6.0)),
            book("five", FieldValue.Number(5.0)),
            book("text", FieldValue.Text("4")),
        )
        runCurrent()
        val rows = vm.state.value.sections.flatMap { it.rows }.associate { it.title to it.rating }
        assertEquals(
            mapOf(
                "Book four" to 4,
                "Book zero" to null,
                "Book none" to null,
                "Book six" to null,
                "Book five" to 5,
                "Book text" to null,
            ),
            rows,
        )
        vm.close()
    }

    @Test fun `a collection whose rating is not a number has no stars`() = runTest(dispatcher) {
        val text = bookProperty("rating", PropertyKind.TEXT)
        val vm = viewModel(booksDatabase("books", text), book("a", FieldValue.Text("4")))
        runCurrent()
        assertEquals(null, vm.state.value.sections.flatMap { it.rows }.single().rating)
        vm.close()
    }
}
