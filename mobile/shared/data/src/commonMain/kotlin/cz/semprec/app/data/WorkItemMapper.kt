package cz.semprec.app.data

import cz.semprec.app.core.EntityRef
import cz.semprec.app.core.ItemKind
import cz.semprec.app.core.LinkState
import cz.semprec.app.core.ProjectRef
import cz.semprec.app.core.TaskRepeat
import cz.semprec.app.core.TaskStatus
import cz.semprec.app.core.ValueLink
import cz.semprec.app.domain.Schedule
import cz.semprec.app.domain.WorkItem
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

private val STATUSES = mapOf(
    "notDone" to TaskStatus.NOT_DONE,
    "done" to TaskStatus.DONE,
    "wontDo" to TaskStatus.WONT_DO,
    "missed" to TaskStatus.MISSED,
)

private val PRESETS = mapOf(
    "daily" to TaskRepeat.DAILY,
    "weekdays" to TaskRepeat.WEEKDAYS,
    "weekly" to TaskRepeat.WEEKLY,
    "monthly" to TaskRepeat.MONTHLY,
)

/** The stored key of [status]. */
internal fun TaskStatus.wireName(): String = STATUSES.entries.first { it.value == this }.key

/** The preset the recurrence route takes for [repeat], or `null` for a repeat the app does not set. */
internal fun TaskRepeat.presetName(): String? = PRESETS.entries.firstOrNull { it.value == this }?.key

/** An item of the generic API as the task or event it is; a target the reader may not see is left out. */
internal fun ItemDto.toWorkItem(kind: ItemKind): WorkItem {
    val people = relations["people"].visible().map { it.toEntity() }
    return WorkItem(
        kind = kind,
        id = id,
        version = version,
        title = properties.text(WorkKeys.NAME).orEmpty(),
        schedule = Schedule(
            date = properties.text(WorkKeys.DATE),
            timeFrom = properties.text(WorkKeys.TIME_FROM),
            timeTo = properties.text(WorkKeys.TIME_TO),
            endDate = properties.text(WorkKeys.END_DATE),
        ),
        description = properties.text(WorkKeys.DESCRIPTION).orEmpty(),
        status = STATUSES[properties.text(WorkKeys.STATUS)] ?: TaskStatus.NOT_DONE,
        effectiveDate = properties.text(WorkKeys.EFFECTIVE_DATE),
        flagged = properties.flag(WorkKeys.FLAGGED),
        repeat = properties.repeat(),
        place = properties.text(WorkKeys.PLACE).orEmpty(),
        project = relations[WorkKeys.PROJECT].visible().firstOrNull()?.toProject(),
        people = people,
        files = relations[WorkKeys.FILES].visible().map { it.toEntity() },
        hostEvents = relations[WorkKeys.HOST_EVENTS].visible().map { it.toEntity() },
        company = relations[WorkKeys.COMPANY].visible().firstOrNull()?.toEntity(),
        projectLink = links[WorkKeys.PROJECT]?.toValueLink(),
        peopleLink = links["people"]?.toValueLink(),
    )
}

private fun List<RelationTargetDto>?.visible(): List<RelationTargetDto> = orEmpty().filterNot { it.hidden }

internal fun RelationTargetDto.toEntity(): EntityRef = EntityRef(id, title, color)

private fun RelationTargetDto.toProject(): ProjectRef {
    val area = properties?.elements(WorkKeys.AREA)?.firstNotNullOfOrNull { (it as? JsonObject)?.toAreaRef() }
    return ProjectRef(id, title, color, area?.id, area?.title)
}

private fun JsonObject.toAreaRef(): EntityRef? {
    val id = text("id") ?: return null
    return EntityRef(id, text("title").orEmpty(), text(WorkKeys.COLOR))
}

private fun JsonObject.repeat(): TaskRepeat {
    val recurrence = this[WorkKeys.RECURRENCE]
    if (recurrence !is JsonObject) return TaskRepeat.NONE
    return PRESETS[recurrence.text("preset")] ?: TaskRepeat.CUSTOM
}

private fun ValueLinkDto.toValueLink(): ValueLink? {
    val state = when (valueKind) {
        "inherited" -> LinkState.INHERITED
        "inheritedBroken" -> LinkState.BROKEN
        "derived" -> LinkState.DERIVED
        else -> return null
    }
    return ValueLink(state, sources.firstOrNull { it.kind == "item" }?.title, brokenBySemp = brokenBy == "agent")
}

/** A checkbox property that is on unless it is stored as off. */
internal fun JsonObject.checkedByDefault(key: String): Boolean =
    (this[key] as? JsonPrimitive)?.booleanOrNull ?: true
