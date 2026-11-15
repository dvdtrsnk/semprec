package cz.semprec.app.domain

import cz.semprec.app.core.FailureKind

/**
 * The items a relation property can be pointed at, found in the database it targets by a text search. The target
 * database's own picker filter applies, so a project picker leaves out finished and archived projects by default.
 */
class FindRelationTargets(private val reads: CollectionReads) {
    suspend operator fun invoke(property: CollectionProperty, search: String): RepositoryResult<List<RelationTarget>> {
        val schema = when (val loaded = reads.schema()) {
            is RepositoryResult.Failure -> return loaded
            is RepositoryResult.Content -> loaded.value
        }
        val target = property.targetDatabaseId?.let(schema::databaseById)
            ?: return RepositoryResult.Failure(FailureKind.NOT_FOUND)
        val query = CollectionQuery(quickFilter = target.pickerFilter, search = search.ifBlank { null }, limit = LIMIT)
        return when (val page = reads.query(target, query)) {
            is RepositoryResult.Failure -> page
            is RepositoryResult.Content -> RepositoryResult.Content(
                page.value.items.map { item ->
                    val title = (target.title?.let { item.values[it.key] } as? FieldValue.Text)?.text.orEmpty()
                    RelationTarget(item.id, target.key, title, null)
                },
            )
        }
    }

    private companion object {
        const val LIMIT = 25
    }
}
