package cz.alldots.app.data

import cz.alldots.app.domain.CalendarAgendaPage
import cz.alldots.app.domain.CalendarAgendaRepository
import cz.alldots.app.domain.CalendarDay
import cz.alldots.app.domain.RepositoryResult
import cz.alldots.app.domain.map
import io.ktor.http.HttpMethod
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * The agenda over `GET /api/calendar/agenda`, forward from a day, a page of [PAGE_SIZE] items at a time. Its items
 * have the shape of the timeline's and are read the same way; an item the app cannot read is left out.
 */
class HttpCalendarAgendaRepository(private val api: AuthenticatedApi) : CalendarAgendaRepository {

    override suspend fun page(from: CalendarDay, cursor: String?): RepositoryResult<CalendarAgendaPage> {
        val query = listOfNotNull(
            "from" to from.toString(),
            "direction" to FORWARD,
            "limit" to PAGE_SIZE.toString(),
            cursor?.let { "cursor" to it },
        )
        return api.send(HttpMethod.Get, PATH, query = query).decode<CalendarAgendaResponse>().map { page ->
            val dtos = page.items.mapNotNull { it.toEntryDto() }
            val titles = dtos.filter { it.kind == TASK }.associate { it.id to it.title.orEmpty() }
            CalendarAgendaPage(dtos.mapNotNull { it.toEntry(titles) }, page.nextCursor)
        }
    }

    private companion object {
        const val PATH = "/api/calendar/agenda"
        const val FORWARD = "forward"
        const val TASK = "task"
        const val PAGE_SIZE = 50
    }
}

/** `GET /api/calendar/agenda`. */
@Serializable
internal data class CalendarAgendaResponse(val items: List<JsonObject>, val nextCursor: String? = null)
