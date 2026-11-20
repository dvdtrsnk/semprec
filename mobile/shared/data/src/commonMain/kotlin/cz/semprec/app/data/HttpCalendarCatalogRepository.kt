package cz.semprec.app.data

import cz.semprec.app.domain.CalendarCancellationImpact
import cz.semprec.app.domain.CalendarCatalogRepository
import cz.semprec.app.domain.CalendarChanges
import cz.semprec.app.domain.CalendarEdit
import cz.semprec.app.domain.CalendarInfo
import cz.semprec.app.domain.RepositoryResult
import io.ktor.http.HttpMethod
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/** The calendars query, with the internet account of each synced calendar. */
private const val CALENDARS_WITH_ACCOUNT = """{"include":{"relations":{"$ACCOUNT_RELATION":[]}}}"""

/**
 * The calendars of the tenant through the item routes of the Calendars database: a calendar is hidden, renamed,
 * recoloured or muted by patching its own properties against the version the list carried, so the same choice shows
 * on every device. A calendar of an internet account changes only here; the provider keeps its own name and colour.
 * Each successful write raises [changes].
 */
class HttpCalendarCatalogRepository(
    private val api: AuthenticatedApi,
    private val changes: CalendarChanges,
) : CalendarCatalogRepository {
    private val databases = CalendarDatabases(api)

    override suspend fun calendars(): RepositoryResult<List<CalendarInfo>> =
        when (val items = databases.items(CalendarDatabaseKeys.CALENDARS, CALENDARS_WITH_ACCOUNT)) {
            is RepositoryResult.Failure -> items
            is RepositoryResult.Content -> RepositoryResult.Content(items.value.mapNotNull { it.toCalendar() })
        }

    override suspend fun edit(calendar: CalendarInfo, change: CalendarEdit): RepositoryResult<Unit> {
        val properties = buildJsonObject {
            change.name?.let { put("name", JsonPrimitive(it)) }
            if (change.useRemoteColor) {
                put("color", JsonNull)
            } else {
                change.color?.let { put("color", JsonPrimitive(it)) }
            }
            change.notify?.let { put("notify", JsonPrimitive(it)) }
            change.hidden?.let { put("hidden", JsonPrimitive(it)) }
        }
        val body = ApiJson.encodeToString(CalendarPatchRequest(properties, calendar.version))
        return api.send(HttpMethod.Patch, "/api/items/${calendar.id}", body = body).ignoreBody().alsoChanged()
    }

    override suspend fun create(name: String, color: String): RepositoryResult<String> =
        when (val database = databases.id(CalendarDatabaseKeys.CALENDARS)) {
            is RepositoryResult.Failure -> database
            is RepositoryResult.Content -> {
                val properties: JsonObject = buildJsonObject {
                    put("name", JsonPrimitive(name))
                    put("color", JsonPrimitive(color))
                    put("notify", JsonPrimitive(true))
                    put("hidden", JsonPrimitive(false))
                }
                val body = ApiJson.encodeToString(CalendarCreateRequest(properties))
                val path = "/api/databases/${database.value}/items"
                when (val created = api.send(HttpMethod.Post, path, body = body).decode<CalendarStoredItem>()) {
                    is RepositoryResult.Failure -> created
                    is RepositoryResult.Content -> RepositoryResult.Content(created.value.id).alsoChanged()
                }
            }
        }

    override suspend fun cancellationImpact(calendarId: String): RepositoryResult<CalendarCancellationImpact> {
        val response = api.send(HttpMethod.Get, "/api/calendar/calendars/$calendarId/cancellation-impact")
        return when (val impact = response.decode<CancellationImpactDto>()) {
            is RepositoryResult.Failure -> impact
            is RepositoryResult.Content -> RepositoryResult.Content(
                CalendarCancellationImpact(
                    impact.value.eventCount,
                    impact.value.recipientCount,
                    impact.value.cancellationCount,
                ),
            )
        }
    }

    override suspend fun delete(calendarId: String): RepositoryResult<Unit> =
        api.send(HttpMethod.Delete, "/api/items/$calendarId").ignoreBody().alsoChanged()

    private fun <T> RepositoryResult<T>.alsoChanged(): RepositoryResult<T> {
        if (this is RepositoryResult.Content) changes.changed()
        return this
    }
}
