package cz.semprec.app.domain

import cz.semprec.app.core.FailureKind
import cz.semprec.app.core.ItemKind
import cz.semprec.app.core.TaskStatus

/** A task or an event that is coming up in an area. [date] is `yyyy-MM-dd`, the times are `HH:mm`. */
data class AreaUpcoming(
    val kind: ItemKind,
    val id: String,
    val title: String,
    val date: String?,
    val timeFrom: String?,
    val timeTo: String?,
    val projectTitle: String?,
    val projectColor: String?,
)

/** One collection connected to the area, with the filter that selects exactly the connected items. */
data class AreaRelated(
    val databaseKey: String?,
    val databaseId: String,
    val name: String,
    val icon: String?,
    val color: String?,
    val count: Int,
    val filter: FilterTree?,
)

/**
 * An area as its screen shows it. [version] is what the next write must name; [tasksToday] counts the open tasks that
 * are due today or late, [tasksOpen] every open task of the area's projects, [eventsSoon] the events that have not
 * happened yet.
 */
data class AreaOverview(
    val id: String,
    val version: String,
    val name: String,
    val color: String?,
    val icon: String?,
    val active: Boolean,
    val tasksToday: Int,
    val tasksOpen: Int,
    val eventsSoon: Int,
    val upcoming: List<AreaUpcoming>,
    val related: List<AreaRelated>,
)

private const val AREAS_KEY = "areas"
private const val EVENTS_KEY = "events"
private const val UPCOMING_PRESET = "upcoming"
private const val UPCOMING_LIMIT = 8
private const val EVENTS_LIMIT = 20
private const val DATE_LENGTH = 10
private const val TIME_START = 11
private const val TIME_END = 16

/**
 * Reads one area: the area itself, what is connected to it, and what is coming up in it. A task belongs to an area
 * through its project; an event through its own area. A missing area is [FailureKind.NOT_FOUND].
 */
class LoadAreaOverview(private val reads: CollectionReads, private val tasks: TaskRepository) {
    suspend operator fun invoke(areaId: String, today: String): RepositoryResult<AreaOverview> =
        reads.schema().then { schema ->
            val areas = schema.database(AREAS_KEY)
            if (areas == null) {
                RepositoryResult.Failure(FailureKind.NOT_FOUND)
            } else {
                reads.item(areaId, emptyList()).then { item ->
                    reads.related(areaId).then { related ->
                        tasks.tasks(TaskScope.ALL).then { all ->
                            eventsOf(schema, areaId).map { events ->
                                item.toOverview(areas, all.ofArea(areaId), events, related.connected(schema), today)
                            }
                        }
                    }
                }
            }
        }

    private suspend fun eventsOf(schema: CollectionSchema, areaId: String): RepositoryResult<List<AreaUpcoming>> {
        val events = schema.database(EVENTS_KEY)
        val date = events?.properties?.let { all ->
            all.firstOrNull { it.kind == PropertyKind.DATE && !it.system }
                ?: all.firstOrNull { it.kind == PropertyKind.DATE }
        }
        if (events == null || date == null) return RepositoryResult.Content(emptyList())
        val query = CollectionQuery(
            scope = CollectionScope.Area(areaId),
            selections = listOf(FacetSelection.DatePreset(date.key, UPCOMING_PRESET)),
            sort = listOf(SortSpec(date.key, null, descending = false)),
            limit = EVENTS_LIMIT,
        )
        return reads.query(events, query).map { page ->
            page.items.map { item -> item.toUpcoming(events.title?.key, date.key) }
        }
    }
}

private fun List<WorkItem>.ofArea(areaId: String): List<WorkItem> =
    filter { it.status == TaskStatus.NOT_DONE && it.project?.areaId == areaId }

private fun CollectionItem.toOverview(
    areas: CollectionDatabase,
    openTasks: List<WorkItem>,
    events: List<AreaUpcoming>,
    related: List<AreaRelated>,
    today: String,
): AreaOverview {
    val tasks = openTasks.map { it.toUpcoming() }
    return AreaOverview(
        id = id,
        version = version,
        name = areas.title?.key?.let { (values[it] as? FieldValue.Text)?.text }.orEmpty(),
        color = (values["color"] as? FieldValue.Text)?.text,
        icon = (values["icon"] as? FieldValue.Text)?.text,
        // An area is active unless it says otherwise.
        active = (values["active"] as? FieldValue.Flag)?.on ?: true,
        tasksToday = openTasks.count { (it.effectiveDate ?: it.schedule.date)?.let { day -> day <= today } == true },
        tasksOpen = openTasks.size,
        eventsSoon = events.size,
        upcoming = (tasks + events).sortedWith(compareBy({ it.date ?: "9999" }, { it.timeFrom ?: "" }, { it.title }))
            .take(UPCOMING_LIMIT),
        related = related,
    )
}

/** The collections of [schema] that hold something connected to the area; one the schema does not know is left out. */
private fun List<RelatedCollection>.connected(schema: CollectionSchema): List<AreaRelated> = mapNotNull { connected ->
    schema.databaseById(connected.databaseId)?.let { database ->
        AreaRelated(
            databaseKey = connected.databaseKey,
            databaseId = connected.databaseId,
            name = database.name,
            icon = database.icon,
            color = database.color,
            count = connected.count,
            filter = connected.filter,
        )
    }
}.filter { it.count > 0 }

private fun WorkItem.toUpcoming() = AreaUpcoming(
    kind = kind,
    id = id,
    title = title,
    date = effectiveDate ?: schedule.date,
    timeFrom = schedule.timeFrom,
    timeTo = schedule.timeTo,
    projectTitle = project?.title,
    projectColor = project?.color,
)

private fun CollectionItem.toUpcoming(titleKey: String?, dateKey: String): AreaUpcoming {
    val stamp = (values[dateKey] as? FieldValue.Text)?.text
    val from = stamp?.takeIf { it.length >= TIME_END }?.substring(TIME_START, TIME_END)
    return AreaUpcoming(
        kind = ItemKind.EVENT,
        id = id,
        title = titleKey?.let { (values[it] as? FieldValue.Text)?.text }.orEmpty(),
        date = stamp?.take(DATE_LENGTH),
        timeFrom = from,
        timeTo = null,
        projectTitle = null,
        projectColor = null,
    )
}

/** Makes an area active or inactive; an inactive area is hidden from the overview. */
class SetAreaActive(private val reads: CollectionReads, private val writes: CollectionWrites) {
    suspend operator fun invoke(areaId: String, version: String, active: Boolean): RepositoryResult<String> =
        reads.schema().then { schema ->
            val areas = schema.database(AREAS_KEY)
            if (areas == null) {
                RepositoryResult.Failure(FailureKind.NOT_FOUND)
            } else {
                writes.update(areas, areaId, version, mapOf("active" to FieldValue.Flag(active))).map { it.version }
            }
        }
}
