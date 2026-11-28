package cz.alldots.app.domain

import cz.alldots.app.core.FailureKind
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope

/** A collection connected to an item, with the database it holds. */
data class RelatedDetail(val database: CollectionDatabase, val count: Int, val filter: FilterTree?)

/** One item with its database and the collections connected to it. */
data class ItemDetail(
    val item: CollectionItem,
    val database: CollectionDatabase,
    val related: List<RelatedDetail>,
    val today: String,
)

/**
 * Reads one item for its detail screen: the item with the relations its database shows as properties, and, beside
 * it, the collections connected to it. A missing list of related collections is not a failure of the detail: the
 * item still shows. An item of a database the schema does not describe is [FailureKind.INVALID_DATA].
 *
 * [databaseKeyHint] is the key of the database the caller expects the item to belong to; it saves one read, because
 * the relations to expand are known before the item is. Without it, or with a wrong one, the item is read twice.
 */
class LoadItemDetail(private val reads: CollectionReads) {
    suspend operator fun invoke(itemId: String, databaseKeyHint: String?): RepositoryResult<ItemDetail> {
        val schema = when (val loaded = reads.schema()) {
            is RepositoryResult.Failure -> return loaded
            is RepositoryResult.Content -> loaded.value
        }
        val hinted = databaseKeyHint?.let(schema::database)
        return coroutineScope {
            val relatedCall = async { reads.related(itemId) }
            val itemResult = readItem(itemId, hinted, schema)
            val related = (relatedCall.await() as? RepositoryResult.Content)?.value.orEmpty()
            when (itemResult) {
                is RepositoryResult.Failure -> itemResult
                is RepositoryResult.Content -> {
                    val database = schema.databaseById(itemResult.value.databaseId)
                    if (database == null) RepositoryResult.Failure(FailureKind.INVALID_DATA)
                    else RepositoryResult.Content(
                        ItemDetail(
                            itemResult.value,
                            database,
                            related.mapNotNull { row ->
                                schema.databaseById(row.databaseId)?.let { RelatedDetail(it, row.count, row.filter) }
                            },
                            schema.today,
                        ),
                    )
                }
            }
        }
    }

    private suspend fun readItem(
        itemId: String,
        hinted: CollectionDatabase?,
        schema: CollectionSchema,
    ): RepositoryResult<CollectionItem> {
        val first = reads.item(itemId, hinted?.contextRelations()?.map { it.key }.orEmpty())
        val actual = (first as? RepositoryResult.Content)?.let { schema.databaseById(it.value.databaseId) }
        return if (actual == null || actual.id == hinted?.id) {
            first
        } else {
            reads.item(itemId, actual.contextRelations().map { it.key })
        }
    }
}
