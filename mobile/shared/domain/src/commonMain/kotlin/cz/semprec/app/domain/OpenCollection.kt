package cz.semprec.app.domain

import cz.semprec.app.core.FailureKind

/** A database and the tenant's calendar day, as a collection screen needs them to open. */
data class OpenedCollection(val database: CollectionDatabase, val today: String)

/**
 * Finds the database a collection shows, by its canonical key or its id. A database the server does not have is
 * [FailureKind.NOT_FOUND]; an area scope on a database that declares no area filter would show every item as if it
 * were the area's, so it is [FailureKind.INVALID_DATA] instead.
 */
class OpenCollection(private val reads: CollectionReads) {
    suspend operator fun invoke(
        databaseKey: String?,
        databaseId: String?,
        scope: CollectionScope,
    ): RepositoryResult<OpenedCollection> {
        val schema = when (val loaded = reads.schema()) {
            is RepositoryResult.Failure -> return loaded
            is RepositoryResult.Content -> loaded.value
        }
        val database = databaseKey?.let(schema::database) ?: databaseId?.let(schema::databaseById)
        return when {
            database == null -> RepositoryResult.Failure(FailureKind.NOT_FOUND)
            scope is CollectionScope.Area && database.areaFilter == null ->
                RepositoryResult.Failure(FailureKind.INVALID_DATA)
            else -> RepositoryResult.Content(OpenedCollection(database, schema.today))
        }
    }
}
