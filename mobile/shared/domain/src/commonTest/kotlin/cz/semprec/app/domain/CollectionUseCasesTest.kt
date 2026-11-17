package cz.semprec.app.domain

import cz.semprec.app.core.FailureKind
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

private fun property(key: String, kind: PropertyKind, target: String? = null) =
    CollectionProperty("id-$key", key, key, kind, emptyList(), target, system = false, filterable = true)

private fun database(id: String, key: String, areaFilter: Boolean = false, vararg properties: CollectionProperty) =
    CollectionDatabase(
        id = id,
        key = key,
        name = key,
        icon = null,
        color = null,
        searchPlaceholder = null,
        properties = listOf(property("name", PropertyKind.TITLE)) + properties,
        quickFilters = emptyList(),
        defaultSort = SortSpec(null, "createdAt", true),
        dateLabels = null,
        collectionFilter = null,
        areaFilter = if (areaFilter) FilterTree("{}") else null,
        pickerFilter = FilterTree("""{"picker":true}"""),
    )

private val areas = database("db-areas", "areas")
private val projects = database(
    "db-projects",
    "projects",
    true,
    property("area", PropertyKind.RELATION, "db-areas"),
    property("company", PropertyKind.RELATION, "db-companies"),
    property("tasks", PropertyKind.RELATION, "db-tasks"),
)
private val schema = CollectionSchema("2026-10-16", listOf(areas, projects))

/** A [CollectionReads] that answers from fixed values and records how it was asked. */
private class StubReads(
    var schemaAnswer: RepositoryResult<CollectionSchema> = RepositoryResult.Content(schema),
    var itemAnswer: RepositoryResult<CollectionItem> = RepositoryResult.Content(item("p1", "db-projects")),
    var relatedAnswer: RepositoryResult<List<RelatedCollection>> = RepositoryResult.Content(emptyList()),
    var queryAnswer: RepositoryResult<CollectionPage> = RepositoryResult.Content(CollectionPage(emptyList(), null)),
) : CollectionReads {
    val expansions = mutableListOf<List<String>>()
    val queries = mutableListOf<Pair<CollectionDatabase, CollectionQuery>>()

    override suspend fun schema() = schemaAnswer
    override suspend fun refreshSchema() = schemaAnswer
    override suspend fun query(database: CollectionDatabase, query: CollectionQuery): RepositoryResult<CollectionPage> {
        queries += database to query
        return queryAnswer
    }

    override suspend fun facets(database: CollectionDatabase, query: CollectionQuery, propertyKeys: List<String>) =
        RepositoryResult.Content(emptyList<FacetResult>())

    override suspend fun item(itemId: String, expand: List<String>): RepositoryResult<CollectionItem> {
        expansions += expand
        return itemAnswer
    }

    override suspend fun related(itemId: String) = relatedAnswer
    override suspend fun deleteImpact(
        itemId: String
    ) = RepositoryResult.Content(DeleteImpact(emptyList(), 0, 0, 0, 0, 0, 0))
    override suspend fun page(itemId: String) = RepositoryResult.Content(PageContent("", ""))
    override suspend fun blob(blobId: String) = RepositoryResult.Content(BlobContent("a/b", byteArrayOf()))
}

private fun item(id: String, databaseId: String, title: String = "T") =
    CollectionItem(id, databaseId, mapOf("name" to FieldValue.Text(title)), emptyMap(), "c", "v")

class OpenCollectionTest {
    @Test fun `finds a database by key`() = runTest {
        val opened = OpenCollection(StubReads())("projects", null, CollectionScope.Everything)
        assertEquals(projects, assertIs<RepositoryResult.Content<OpenedCollection>>(opened).value.database)
        assertEquals("2026-10-16", opened.value.today)
    }

    @Test fun `finds a database by id when there is no key`() = runTest {
        val opened = OpenCollection(StubReads())(null, "db-areas", CollectionScope.Everything)
        assertEquals(areas, assertIs<RepositoryResult.Content<OpenedCollection>>(opened).value.database)
    }

    @Test fun `an unknown key falls back to the id and no database at all is not found`() = runTest {
        val opened = OpenCollection(StubReads())("nope", "db-areas", CollectionScope.Everything)
        assertEquals(areas, assertIs<RepositoryResult.Content<OpenedCollection>>(opened).value.database)
        val none = OpenCollection(StubReads())("nope", null, CollectionScope.Everything)
        assertEquals(FailureKind.NOT_FOUND, assertIs<RepositoryResult.Failure>(none).kind)
        val neither = OpenCollection(StubReads())(null, null, CollectionScope.Everything)
        assertEquals(FailureKind.NOT_FOUND, assertIs<RepositoryResult.Failure>(neither).kind)
    }

    @Test fun `an area scope needs a database that declares an area filter`() = runTest {
        val refused = OpenCollection(StubReads())("areas", null, CollectionScope.Area("a"))
        assertEquals(FailureKind.INVALID_DATA, assertIs<RepositoryResult.Failure>(refused).kind)
        val allowed = OpenCollection(StubReads())("projects", null, CollectionScope.Area("a"))
        assertIs<RepositoryResult.Content<OpenedCollection>>(allowed)
    }

    @Test fun `a schema failure is passed on`() = runTest {
        val reads = StubReads(schemaAnswer = RepositoryResult.Failure(FailureKind.UNAUTHORIZED))
        val opened = OpenCollection(reads)("projects", null, CollectionScope.Everything)
        assertEquals(FailureKind.UNAUTHORIZED, assertIs<RepositoryResult.Failure>(opened).kind)
    }
}

class LoadItemDetailTest {
    private val related = listOf(
        RelatedCollection("areas", "db-areas", 2, FilterTree("{}")),
        RelatedCollection("gone", "db-gone", 5, null),
    )

    @Test fun `reads the item with the relations of the hinted database and the related collections`() = runTest {
        val reads = StubReads(relatedAnswer = RepositoryResult.Content(related))
        val detail = assertIs<RepositoryResult.Content<ItemDetail>>(LoadItemDetail(reads)("p1", "projects")).value
        assertEquals(listOf(listOf("area", "company")), reads.expansions)
        assertEquals(projects, detail.database)
        assertEquals(listOf("areas"), detail.related.map { it.database.key })
        assertEquals(2, detail.related.single().count)
        assertEquals("2026-10-16", detail.today)
    }

    @Test fun `an item of another database than the hint is read again with its own relations`() = runTest {
        val reads = StubReads(itemAnswer = RepositoryResult.Content(item("a1", "db-areas")))
        val detail = assertIs<RepositoryResult.Content<ItemDetail>>(LoadItemDetail(reads)("a1", "projects")).value
        assertEquals(areas, detail.database)
        assertEquals(listOf(listOf("area", "company"), emptyList()), reads.expansions)
    }

    @Test fun `without a hint the item is read twice and with the right hint once`() = runTest {
        val reads = StubReads()
        LoadItemDetail(reads)("p1", null)
        assertEquals(listOf(emptyList(), listOf("area", "company")), reads.expansions)
        val hinted = StubReads()
        LoadItemDetail(hinted)("p1", "projects")
        assertEquals(1, hinted.expansions.size)
    }

    @Test fun `an unknown hint reads like no hint`() = runTest {
        val reads = StubReads()
        LoadItemDetail(reads)("p1", "nope")
        assertEquals(2, reads.expansions.size)
    }

    @Test fun `a failed related read leaves the item`() = runTest {
        val reads = StubReads(relatedAnswer = RepositoryResult.Failure(FailureKind.UNAVAILABLE))
        val detail = assertIs<RepositoryResult.Content<ItemDetail>>(LoadItemDetail(reads)("p1", "projects")).value
        assertEquals(emptyList(), detail.related)
    }

    @Test fun `a missing item is passed on and an item of an unknown database is invalid`() = runTest {
        val missing = StubReads(itemAnswer = RepositoryResult.Failure(FailureKind.NOT_FOUND))
        assertEquals(
            FailureKind.NOT_FOUND,
            assertIs<RepositoryResult.Failure>(
                LoadItemDetail(missing)(
                    "p1",
                    "projects"
                )
            ).kind
        )
        val strange = StubReads(itemAnswer = RepositoryResult.Content(item("x", "db-unknown")))
        assertEquals(
            FailureKind.INVALID_DATA,
            assertIs<RepositoryResult.Failure>(
                LoadItemDetail(strange)(
                    "x",
                    null
                )
            ).kind
        )
    }

    @Test fun `a schema failure is passed on without reading the item`() = runTest {
        val reads = StubReads(schemaAnswer = RepositoryResult.Failure(FailureKind.UNAVAILABLE))
        assertEquals(
            FailureKind.UNAVAILABLE,
            assertIs<RepositoryResult.Failure>(
                LoadItemDetail(reads)(
                    "p1",
                    null
                )
            ).kind
        )
        assertTrue(reads.expansions.isEmpty())
    }
}

class FindRelationTargetsTest {
    private val area = projects.property("area")!!

    @Test fun `searches the target database with its picker filter and names the items by title`() = runTest {
        val reads =
            StubReads(
                queryAnswer = RepositoryResult.Content(
                    CollectionPage(
                        listOf(item("a1", "db-areas", "Work")),
                        null
                    )
                )
            )
        val found = FindRelationTargets(reads)(area, "wo")
        assertEquals(
            listOf(RelationTarget("a1", "areas", "Work", null)),
            assertIs<RepositoryResult.Content<List<RelationTarget>>>(found).value
        )
        val (searched, query) = reads.queries.single()
        assertEquals(areas, searched)
        assertEquals("wo", query.search)
        assertEquals("""{"picker":true}""", query.quickFilter?.json)
    }

    @Test fun `a blank search asks for no text`() = runTest {
        val reads = StubReads()
        FindRelationTargets(reads)(area, "   ")
        assertNull(reads.queries.single().second.search)
    }

    @Test fun `a relation whose target the schema lacks is not found`() = runTest {
        val tasks = projects.property("tasks")!!
        val found = FindRelationTargets(StubReads())(tasks, "")
        assertEquals(FailureKind.NOT_FOUND, assertIs<RepositoryResult.Failure>(found).kind)
        val withoutTarget = FindRelationTargets(StubReads())(property("x", PropertyKind.RELATION), "")
        assertEquals(FailureKind.NOT_FOUND, assertIs<RepositoryResult.Failure>(withoutTarget).kind)
    }

    @Test fun `failures of the schema and of the search are passed on`() = runTest {
        val noSchema = StubReads(schemaAnswer = RepositoryResult.Failure(FailureKind.UNAUTHORIZED))
        assertEquals(
            FailureKind.UNAUTHORIZED,
            assertIs<RepositoryResult.Failure>(
                FindRelationTargets(noSchema)(
                    area,
                    ""
                )
            ).kind
        )
        val noQuery = StubReads(queryAnswer = RepositoryResult.Failure(FailureKind.UNAVAILABLE))
        assertEquals(
            FailureKind.UNAVAILABLE,
            assertIs<RepositoryResult.Failure>(
                FindRelationTargets(noQuery)(
                    area,
                    ""
                )
            ).kind
        )
    }
}

class CollectionDatabaseTest {
    @Test fun `context relations are the belonging relations in their order and at most five`() {
        assertEquals(listOf("area", "company"), projects.contextRelations().map { it.key })
        val many = database(
            "d",
            "d",
            false,
            *CONTEXT_RELATIONS.map {
                property(it, PropertyKind.RELATION, "x")
            }.plus(property("extra", PropertyKind.RELATION, "x")).toTypedArray(),
        )
        assertEquals(CONTEXT_RELATIONS.take(5), many.contextRelations().map { it.key })
        val notRelation = database("n", "n", false, property("area", PropertyKind.TEXT))
        assertEquals(emptyList(), notRelation.contextRelations())
    }

    @Test fun `the schema finds databases by key and by id`() {
        assertEquals(projects, schema.database("projects"))
        assertEquals(areas, schema.databaseById("db-areas"))
        assertNull(schema.database("nope"))
        assertNull(schema.databaseById("nope"))
        assertNull(areas.property("missing"))
        assertEquals("name", areas.title?.key)
    }
}
