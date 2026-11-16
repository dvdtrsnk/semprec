package cz.semprec.app.data

import cz.semprec.app.core.FailureKind
import cz.semprec.app.domain.RepositoryResult
import io.ktor.http.HttpMethod

/** The canonical keys of the databases the calendar reads and writes. */
internal object CalendarDatabaseKeys {
    const val CALENDARS = "calendars"
    const val EVENTS = "events"
    const val TASKS = "tasks"
    const val INVITATIONS = "invitations"
}

/**
 * Finds a database of the tenant by its canonical key through `GET /api/schema`, once, and keeps the answer; the
 * ids belong to the tenant and do not change while the app runs. A tenant that lacks the database is
 * [FailureKind.NOT_FOUND].
 */
internal class CalendarDatabases(private val api: AuthenticatedApi) {
    private var byKey: Map<String, String>? = null

    suspend fun id(key: String): RepositoryResult<String> {
        val known = when (val loaded = byKey?.let { RepositoryResult.Content(it) } ?: loadSchema()) {
            is RepositoryResult.Failure -> return loaded
            is RepositoryResult.Content -> loaded.value
        }
        val found = known[key]
        return if (found == null) RepositoryResult.Failure(FailureKind.NOT_FOUND) else RepositoryResult.Content(found)
    }

    private suspend fun loadSchema(): RepositoryResult<Map<String, String>> {
        val response = api.send(HttpMethod.Get, "/api/schema")
        return when (val schema = response.decode<CalendarSchemaResponse>()) {
            is RepositoryResult.Failure -> schema
            is RepositoryResult.Content -> {
                val ids = schema.value.databases
                    .mapNotNull { database -> database.key?.let { it to database.databaseId } }
                    .toMap()
                byKey = ids
                RepositoryResult.Content(ids)
            }
        }
    }

    /** Reads every item of the database `key` (one query; the databases read here are small). */
    suspend fun items(key: String): RepositoryResult<List<CalendarStoredItem>> =
        when (val database = id(key)) {
            is RepositoryResult.Failure -> database
            is RepositoryResult.Content -> {
                val response = api.send(HttpMethod.Post, "/api/databases/${database.value}/query", body = "{}")
                when (val list = response.decode<CalendarItemList>()) {
                    is RepositoryResult.Failure -> list
                    is RepositoryResult.Content -> RepositoryResult.Content(list.value.items)
                }
            }
        }
}
