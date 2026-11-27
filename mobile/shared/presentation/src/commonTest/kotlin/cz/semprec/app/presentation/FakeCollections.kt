package cz.semprec.app.presentation

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.BlobContent
import cz.semprec.app.domain.BlobRef
import cz.semprec.app.domain.CollectionDatabase
import cz.semprec.app.domain.CollectionItem
import cz.semprec.app.domain.CollectionPage
import cz.semprec.app.domain.CollectionProperty
import cz.semprec.app.domain.CollectionQuery
import cz.semprec.app.domain.CollectionReads
import cz.semprec.app.domain.CollectionSchema
import cz.semprec.app.domain.CollectionWrites
import cz.semprec.app.domain.DeleteImpact
import cz.semprec.app.domain.FacetResult
import cz.semprec.app.domain.FieldValue
import cz.semprec.app.domain.FilterTree
import cz.semprec.app.domain.PageContent
import cz.semprec.app.domain.PropertyKind
import cz.semprec.app.domain.PropertyOption
import cz.semprec.app.domain.QuickFilter
import cz.semprec.app.domain.RelatedCollection
import cz.semprec.app.domain.RelationTarget
import cz.semprec.app.domain.RepositoryResult
import cz.semprec.app.domain.SortSpec

const val PROJECTS = "db-projects"
const val AREAS = "db-areas"
const val FILES = "db-files"

private fun property(
    key: String,
    kind: PropertyKind,
    options: List<PropertyOption> = emptyList(),
    target: String? = null,
    system: Boolean = false,
    filterable: Boolean = true,
) = CollectionProperty(
    "id-$key", key,
    key.replaceFirstChar {
        it.uppercase()
    },
    kind, options, target, system, filterable
)

val STATUS = listOf(
    PropertyOption("inProgress", "In progress", "#007AFF"),
    PropertyOption("longTerm", "Long term", "#34C759"),
    PropertyOption("done", "Done", "#8E8E93"),
)

val projectsDb = CollectionDatabase(
    id = PROJECTS,
    key = "projects",
    name = "Projects",
    icon = "folder",
    color = "#AF52DE",
    searchPlaceholder = "Search projects",
    properties = listOf(
        property("name", PropertyKind.TITLE, filterable = false),
        property("status", PropertyKind.SELECT, STATUS),
        property("date", PropertyKind.DATE),
        property("area", PropertyKind.RELATION, target = AREAS),
        property("company", PropertyKind.RELATION, target = "db-companies"),
        property("tasks", PropertyKind.RELATION, target = "db-tasks"),
        property("pinned", PropertyKind.CHECKBOX),
        property(
            "tags", PropertyKind.MULTI_SELECT,
            listOf(
                PropertyOption("a", "A", null),
                PropertyOption(
                    "b", "B",
                    null
                )
            )
        ),
        property("budget", PropertyKind.NUMBER),
        property("note", PropertyKind.LONG_TEXT),
        property("completedAt", PropertyKind.DATE, system = true),
    ),
    quickFilters = listOf(
        QuickFilter("active", "Active", FilterTree("""{"type":"in"}"""), emptyList(), isDefault = true),
        QuickFilter("all", "All", null, listOf(SortSpec("date", null, false)), isDefault = false),
    ),
    defaultSort = SortSpec(null, "createdAt", descending = true),
    dateLabels = cz.semprec.app.domain.DateLabels("Overdue", "No deadline"),
    collectionFilter = FilterTree("""{"type":"is_empty","property":"systemActive"}"""),
    areaFilter = FilterTree("""{"type":"relation_contains","property":"area","value":{"areaValue":true}}"""),
    pickerFilter = FilterTree("""{"type":"is_empty","property":"x"}"""),
)

val areasDb = CollectionDatabase(
    id = AREAS,
    key = "areas",
    name = "Areas",
    icon = null,
    color = null,
    searchPlaceholder = null,
    properties = listOf(property("name", PropertyKind.TITLE, filterable = false)),
    quickFilters = emptyList(),
    defaultSort = SortSpec("name", null, descending = false),
    dateLabels = null,
    collectionFilter = null,
    areaFilter = null,
    pickerFilter = null,
)

val filesDb = CollectionDatabase(
    id = FILES,
    key = "files",
    name = "Files",
    icon = "doc",
    color = "#636366",
    searchPlaceholder = null,
    properties = listOf(
        property("name", PropertyKind.TITLE, filterable = false),
        property(
            "type", PropertyKind.SELECT,
            listOf(
                PropertyOption("pdf", "PDF", "#FF3B30"),
                PropertyOption(
                    "jpg",
                    "JPG", null
                )
            )
        ),
        property("date", PropertyKind.DATE),
        property("file", PropertyKind.FILE, filterable = false),
        property("projects", PropertyKind.RELATION, target = PROJECTS),
    ),
    quickFilters = emptyList(),
    defaultSort = SortSpec(null, "createdAt", descending = true),
    dateLabels = null,
    collectionFilter = null,
    areaFilter = null,
    pickerFilter = null,
)

val testSchema = CollectionSchema("2026-10-16", listOf(projectsDb, areasDb, filesDb))

fun projectItem(
    id: String,
    title: String,
    status: String? = "inProgress",
    date: String? = null,
    area: String? = null,
    extra: Map<String, FieldValue> = emptyMap(),
    origins: Map<String, cz.semprec.app.domain.ValueOrigin> = emptyMap(),
): CollectionItem {
    val values = buildMap<String, FieldValue> {
        put("name", FieldValue.Text(title))
        status?.let { put("status", FieldValue.Choices(listOf(it))) }
        date?.let { put("date", FieldValue.Text(it)) }
        area?.let { put("area", FieldValue.Targets(listOf(RelationTarget("area-1", "areas", it, "#5856D6")))) }
        putAll(extra)
    }
    return CollectionItem(id, PROJECTS, values, origins, "2026-10-01", "v-$id")
}

fun fileItem(id: String, title: String, type: String = "pdf"): CollectionItem = CollectionItem(
    id,
    FILES,
    mapOf(
        "name" to FieldValue.Text(title),
        "type" to FieldValue.Choices(listOf(type)),
        "file" to FieldValue.File(BlobRef("blob-$id", 2048, "application/pdf", title)),
    ),
    emptyMap(),
    "2026-10-01",
    "v-$id",
)

/** A scripted [CollectionReads] and [CollectionWrites]: every call is recorded and answered by an overridable lambda. */
class FakeCollections : CollectionReads, CollectionWrites {
    var schemaAnswer: suspend () -> RepositoryResult<CollectionSchema> = { RepositoryResult.Content(testSchema) }
    var queryAnswer: suspend (CollectionDatabase, CollectionQuery) -> RepositoryResult<CollectionPage> =
        { _, _ -> RepositoryResult.Content(CollectionPage(emptyList(), null)) }
    var facetsAnswer: suspend () -> RepositoryResult<List<FacetResult>> = { RepositoryResult.Content(emptyList()) }
    var itemAnswer: suspend (String) -> RepositoryResult<CollectionItem> =
        { RepositoryResult.Failure(FailureKind.NOT_FOUND) }
    var relatedAnswer: suspend () -> RepositoryResult<List<RelatedCollection>> =
        { RepositoryResult.Content(emptyList()) }
    var pageAnswer: suspend () -> RepositoryResult<PageContent> = { RepositoryResult.Content(PageContent("", "e0")) }
    var blobAnswer: suspend () -> RepositoryResult<BlobContent> =
        { RepositoryResult.Content(BlobContent("image/png", byteArrayOf(1, 2, 3))) }
    var impactAnswer: suspend () -> RepositoryResult<DeleteImpact> =
        { RepositoryResult.Content(DeleteImpact(emptyList(), 0, 0, 0, 0, 0, 0)) }
    var createAnswer: suspend () -> RepositoryResult<CollectionItem> = {
        RepositoryResult.Content(projectItem("new", "New"))
    }
    var updateAnswer: suspend () -> RepositoryResult<CollectionItem> = {
        RepositoryResult.Content(
            projectItem(
                "p",
                "P"
            )
        )
    }
    var unitAnswer: suspend () -> RepositoryResult<Unit> = { RepositoryResult.Content(Unit) }
    var setRelationAnswer: suspend () -> RepositoryResult<Unit> = { RepositoryResult.Content(Unit) }
    var replacePageAnswer: suspend () -> RepositoryResult<PageContent> = {
        RepositoryResult.Content(PageContent("saved", "e1"))
    }
    var uploadAnswer: suspend () -> RepositoryResult<CollectionItem> = { RepositoryResult.Content(fileItem("f", "F")) }
    var addOptionAnswer: suspend (String) -> RepositoryResult<PropertyOption> =
        { label -> RepositoryResult.Content(PropertyOption(label.lowercase(), label, null)) }

    val queries = mutableListOf<CollectionQuery>()
    val facetQueries = mutableListOf<Pair<CollectionQuery, List<String>>>()
    val calls = mutableListOf<String>()
    val updates = mutableListOf<Triple<String, String, Map<String, FieldValue?>>>()
    val creates = mutableListOf<Triple<String, String, Pair<String, String>?>>()
    val uploads = mutableListOf<Triple<String, String, Pair<String, String>?>>()
    val pageReplacements = mutableListOf<Triple<String, String, String>>()
    var itemReads = 0

    override suspend fun schema() = schemaAnswer()
    override suspend fun refreshSchema(): RepositoryResult<CollectionSchema> {
        calls += "refreshSchema"
        return schemaAnswer()
    }

    override suspend fun query(database: CollectionDatabase, query: CollectionQuery): RepositoryResult<CollectionPage> {
        queries += query
        return queryAnswer(database, query)
    }

    override suspend fun facets(
        database: CollectionDatabase,
        query: CollectionQuery,
        propertyKeys: List<String>,
    ): RepositoryResult<List<FacetResult>> {
        facetQueries += query to propertyKeys
        return facetsAnswer()
    }

    override suspend fun item(itemId: String, expand: List<String>): RepositoryResult<CollectionItem> {
        itemReads += 1
        calls += "item:$itemId:${expand.joinToString(",")}"
        return itemAnswer(itemId)
    }

    override suspend fun related(itemId: String) = relatedAnswer()
    override suspend fun deleteImpact(itemId: String) = impactAnswer()
    override suspend fun page(itemId: String) = pageAnswer()
    override suspend fun blob(blobId: String) = blobAnswer()

    override suspend fun create(
        database: CollectionDatabase,
        title: String,
        relation: Pair<String, String>?,
    ): RepositoryResult<CollectionItem> {
        creates += Triple(database.id, title, relation)
        return createAnswer()
    }

    override suspend fun update(
        database: CollectionDatabase,
        itemId: String,
        version: String,
        changes: Map<String, FieldValue?>,
    ): RepositoryResult<CollectionItem> {
        updates += Triple(itemId, version, changes)
        return updateAnswer()
    }

    override suspend fun setRelation(itemId: String, propertyKey: String, targetId: String?): RepositoryResult<Unit> {
        calls += "set:$itemId:$propertyKey:$targetId"
        return setRelationAnswer()
    }

    override suspend fun link(itemId: String, propertyKey: String, targetId: String): RepositoryResult<Unit> {
        calls += "link:$itemId:$propertyKey:$targetId"
        return unitAnswer()
    }

    override suspend fun unlinkEdge(itemId: String, propertyKey: String, targetId: String): RepositoryResult<Unit> {
        calls += "unlinkEdge:$itemId:$propertyKey:$targetId"
        return unitAnswer()
    }

    override suspend fun unlinkValue(itemId: String, propertyKey: String): RepositoryResult<Unit> {
        calls += "unlinkValue:$itemId:$propertyKey"
        return unitAnswer()
    }

    override suspend fun relinkValue(itemId: String, propertyKey: String): RepositoryResult<Unit> {
        calls += "relinkValue:$itemId:$propertyKey"
        return unitAnswer()
    }

    override suspend fun delete(itemId: String): RepositoryResult<Unit> {
        calls += "delete:$itemId"
        return unitAnswer()
    }

    override suspend fun addOption(property: CollectionProperty, label: String): RepositoryResult<PropertyOption> {
        calls += "addOption:${property.id}:$label"
        return addOptionAnswer(label)
    }

    override suspend fun replacePage(itemId: String, markdown: String, etag: String): RepositoryResult<PageContent> {
        pageReplacements += Triple(itemId, markdown, etag)
        return replacePageAnswer()
    }

    override suspend fun upload(
        filename: String,
        mimeType: String,
        bytes: ByteArray,
        attachTo: Pair<String, String>?,
    ): RepositoryResult<CollectionItem> {
        uploads += Triple(filename, mimeType, attachTo)
        return uploadAnswer()
    }
}

fun page(vararg items: CollectionItem, next: String? = null) =
    RepositoryResult.Content(CollectionPage(items.toList(), next))

fun failure(kind: FailureKind) = RepositoryResult.Failure(kind)
