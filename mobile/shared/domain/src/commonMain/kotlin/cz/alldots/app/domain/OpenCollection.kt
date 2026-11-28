package cz.alldots.app.domain

import cz.alldots.app.core.FailureKind

/** A database and the tenant's calendar day, as a collection screen needs them to open. */
data class OpenedCollection(val database: CollectionDatabase, val today: String)

/** Finds the database a collection shows, by its canonical key or its id; one the server does not have is [FailureKind.NOT_FOUND]. */
class OpenCollection(private val reads: CollectionReads) {
    suspend operator fun invoke(databaseKey: String?, databaseId: String?): RepositoryResult<OpenedCollection> {
        val schema = when (val loaded = reads.schema()) {
            is RepositoryResult.Failure -> return loaded
            is RepositoryResult.Content -> loaded.value
        }
        val database = databaseKey?.let(schema::database) ?: databaseId?.let(schema::databaseById)
        return if (database == null) {
            RepositoryResult.Failure(FailureKind.NOT_FOUND)
        } else {
            RepositoryResult.Content(OpenedCollection(database, schema.today))
        }
    }
}
